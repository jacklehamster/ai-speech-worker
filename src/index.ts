import { getTranslator, fetchTranslations, getTranslatorFromTranslations } from "@dobuki/translation-sheet";

// Simple hash function for cache key
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString();
}

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

const VERSION = "1.0.2";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle preflight OPTIONS requests
    if (request.method === 'OPTIONS') {
      return addCorsHeaders(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/favicon.ico') {
      return Response.redirect("https://jacklehamster.github.io/ai-speech-worker/icon.png");
    }

    // Initialize translator
    const cache = await caches.open("ai-speech");
    if (!translator || url.searchParams.get("clear-cache")) {
      const TRANSLATION_CACHE_KEY = new URL(`${url.origin}/ai-speech-${env.SPREADSHEET_ID}-${env.SHEET_NAME}`);
      if (url.searchParams.get("clear-cache")) {
        await cache.delete(TRANSLATION_CACHE_KEY);
        await cache.delete(new URL(`${url.origin}/list-voices?v=${VERSION}`));
        return addCorsHeaders(new Response(JSON.stringify({ response: "Cache cleared" }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const cachedResponse = await cache.match(TRANSLATION_CACHE_KEY);
      let translations: Awaited<ReturnType<typeof fetchTranslations>>;
      if (cachedResponse) {
        translations = await cachedResponse.json();
      } else {
        try {
          translations = await fetchTranslations(env.SPREADSHEET_ID, {
            credentials: env.SHEETS_SERVICE_KEY_JSON,
            sheetName: env.SHEET_NAME,
          });
          await cache.put(TRANSLATION_CACHE_KEY, new Response(JSON.stringify(translations), {
            headers: { 'Content-Type': 'application/json' },
          }));
        } catch (error) {
          console.error('Translator initialization failed:', error);
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Failed to initialize translator' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }

      try {
        translator = await getTranslatorFromTranslations(translations?.[env.SHEET_NAME]);
      } catch (error) {
        console.error('Translator initialization failed:', error);
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Failed to initialize translator' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    }

    // Validate environment variables
    if (!env.OPENAI_API_KEY || !env.AI_GATEWAY_TOKEN || !env.AI_GATEWAY_URL) {
      console.error('Missing environment variables');
      return addCorsHeaders(new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    let events: any[] = [];
    let prompt: string | null = null;

    // Handle GET or POST request
    if (request.method === 'GET') {
      const eventsParam = url.searchParams.get('events');
      prompt = url.searchParams.get('prompt') ?? url.searchParams.get('finalPrompt');
      if (!prompt) {
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing "prompt" query parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (eventsParam) {
        try {
          events = JSON.parse(eventsParam);
          if (!Array.isArray(events)) {
            throw new Error('Events must be an array');
          }
        } catch (error: any) {
          return addCorsHeaders(new Response(JSON.stringify({ error: `Invalid "events" format: ${error.message}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }
    } else if (request.method === 'POST') {
      try {
        const body: any = await request.json();
        events = body.events || [];
        prompt = body.prompt;
        if (!prompt) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Missing "prompt" in body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (!Array.isArray(events)) {
          return addCorsHeaders(new Response(JSON.stringify({ error: 'Events must be an array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      } catch (error: any) {
        return addCorsHeaders(new Response(JSON.stringify({ error: `Invalid JSON body: ${error.message}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    } else {
      return addCorsHeaders(new Response('Method Not Allowed', { status: 405 }));
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
      return addCorsHeaders(new Response(JSON.stringify({ error: `Invalid "events" format: ${error.message}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    prompt = translator?.translate(prompt) ?? prompt;

    // Cache check for events and prompt
    const CACHE_KEY = new URL(`${url.origin}/response?hash=${simpleHash(JSON.stringify({ events, prompt }))}&v=${VERSION}`);
    const cachedResponse = await cache.match(CACHE_KEY);
    if (cachedResponse) {
      return addCorsHeaders(cachedResponse); // Add CORS headers to cached response
    }
    const systemPromptParam = url.searchParams.get("system-prompt") ?? "SYSTEM_PROMPT";

    // Get and validate system prompt
    const systemPromptFromTranslator = translator?.translate(systemPromptParam);
    const systemPrompt = (systemPromptFromTranslator !== systemPromptParam ? systemPromptFromTranslator : env.SYSTEM_PROMPT) ?? env.SYSTEM_PROMPT;
    if (!systemPrompt) {
      return addCorsHeaders(new Response(JSON.stringify({ error: 'System prompt not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...events,
        { role: 'user', content: prompt },
      ];

      const aiResponse = await fetch(env.AI_GATEWAY_URL, {
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

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error(`AI Gateway error: ${aiResponse.status} ${errorText}`);
        return addCorsHeaders(new Response(JSON.stringify({ error: `AI Gateway error: ${aiResponse.status}` }), {
          status: aiResponse.status,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      const data: any = await aiResponse.json();
      const responseText = data.choices[0]?.message?.content || 'No response generated';

      const response = addCorsHeaders(new Response(JSON.stringify({
        response: responseText,
        // voice: `${url.origin}/voice?msg=${encodeURIComponent(responseText)}`,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=86400',
        },
      }));

      await cache.put(CACHE_KEY, response.clone());
      return response;
    } catch (error: any) {
      console.error('Error:', error);
      return addCorsHeaders(new Response(JSON.stringify({ error: `Failed to process request: ${error.message}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  },
};

function addCorsHeaders(response: Response, origin: string = '*'): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', origin);
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return newResponse;
}
