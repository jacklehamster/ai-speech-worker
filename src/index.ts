import { getTranslator, fetchTranslations, getTranslatorFromTranslations } from "@dobuki/translation-sheet";

interface Env {
  OPENAI_API_KEY: string;
  SYSTEM_PROMPT: string;
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_URL: string;
  SHEETS_SERVICE_KEY_JSON: string;
  SPREADSHEET_ID: string;
  SHEET_NAME: string;
}

let translator: Awaited<ReturnType<typeof getTranslator>>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') {
      return Response.redirect("https://jacklehamster.github.io/ai-speech-worker/icon.png");
    }

    // Initialize translator if not already set
    if (!translator || url.searchParams.get("clear-cache")) {
      const CACHE_KEY = new URL(`${url.origin}/ai-speech-${env.SPREADSHEET_ID}-${env.SHEET_NAME}`);

      const cache = await caches.open("ai-speech");
      if (url.searchParams.get("clear-cache")) {
        cache.delete(CACHE_KEY);
        return new Response(JSON.stringify({ response: "Cache cleared" }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const cachedResponse = await cache.match(CACHE_KEY);

      let translations: Awaited<ReturnType<typeof fetchTranslations>>;
      if (cachedResponse) {
        // Retrieve from cache
        translations = await cachedResponse.json();
      } else {
        // Fetch translations and cache
        try {
          translations = await fetchTranslations(env.SPREADSHEET_ID, {
            credentials: env.SHEETS_SERVICE_KEY_JSON,
            sheetName: env.SHEET_NAME,
          });
          await cache.put(CACHE_KEY, new Response(JSON.stringify(translations), {
            headers: { 'Content-Type': 'application/json' },
          }));
        } catch (error) {
          console.error('Translator initialization failed:', error);
          return new Response(JSON.stringify({ error: 'Failed to initialize translator' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      try {
        translator = await getTranslatorFromTranslations(translations?.[env.SHEET_NAME]);
      } catch (error) {
        console.error('Translator initialization failed:', error);
        return new Response(JSON.stringify({ error: 'Failed to initialize translator' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Validate environment variables
    if (!env.OPENAI_API_KEY || !env.AI_GATEWAY_TOKEN || !env.AI_GATEWAY_URL || !env.SYSTEM_PROMPT) {
      console.error('Missing environment variables');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let events: any[] = [];
    let finalPrompt: string | null = null;

    // Handle GET or POST request
    if (request.method === 'GET') {
      // Extract query parameters
      const url = new URL(request.url);
      const eventsParam = url.searchParams.get('events');
      finalPrompt = url.searchParams.get('finalPrompt');

      if (!finalPrompt) {
        return new Response(JSON.stringify({ error: 'Missing "finalPrompt" query parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (eventsParam) {
        try {
          events = JSON.parse(eventsParam);
          if (!Array.isArray(events)) {
            throw new Error('Events must be an array');
          }
        } catch (error: any) {
          return new Response(JSON.stringify({ error: `Invalid "events" format: ${error.message}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    } else if (request.method === 'POST') {
      // Parse JSON body
      try {
        const body: any = await request.json();
        events = body.events || [];
        finalPrompt = body.finalPrompt;

        if (!finalPrompt) {
          return new Response(JSON.stringify({ error: 'Missing "finalPrompt" in body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (!Array.isArray(events)) {
          return new Response(JSON.stringify({ error: 'Events must be an array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch (error: any) {
        return new Response(JSON.stringify({ error: `Invalid JSON body: ${error.message}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } else {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Validate and translate events
    try {
      events.forEach(event => {
        if (!event.role || !event.content) {
          throw new Error('Each event must have "role" and "content"');
        }
        event.content = translator?.translate(event.content) ?? event.content;
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ error: `Invalid "events" format: ${error.message}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Translate finalPrompt
    finalPrompt = translator?.translate(finalPrompt) ?? finalPrompt;

    // Get and validate system prompt
    const systemPromptFromTranslator = translator?.translate("SYSTEM_PROMPT");
    const systemPrompt = (systemPromptFromTranslator !== "SYSTEM_PROMPT" ? systemPromptFromTranslator : env.SYSTEM_PROMPT) ?? env.SYSTEM_PROMPT;
    if (!systemPrompt) {
      return new Response(JSON.stringify({ error: 'System prompt not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      // Construct message array
      const messages = [
        { role: 'system', content: systemPrompt },
        ...events,
        { role: 'user', content: finalPrompt },
      ];

      // Send request to OpenAI via AI Gateway
      const response = await fetch(env.AI_GATEWAY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 150,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`AI Gateway error: ${response.status} ${errorText}`);
        return new Response(JSON.stringify({ error: `AI Gateway error: ${response.status}` }), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Parse response
      const data: any = await response.json();
      const responseText = data.choices[0]?.message?.content || 'No response generated';

      return new Response(JSON.stringify({ response: responseText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
      console.error('Error:', error.message);
      return new Response(JSON.stringify({ error: `Failed to process request: ${error.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
