import { getTranslator } from "@dobuki/translation-sheet";

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
    // Ensure it's a GET request
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!translator) {
      translator = await getTranslator({
        sheetName: env.SHEET_NAME,
        sheetId: env.SPREADSHEET_ID,
        credentials: env.SHEETS_SERVICE_KEY_JSON,
      });
    }

    // Extract query parameters
    const url = new URL(request.url);
    const eventsParam = url.searchParams.get('events');
    let finalPrompt = url.searchParams.get('finalPrompt');

    // Validate parameters
    if (!finalPrompt) {
      return new Response(JSON.stringify({ error: 'Missing "finalPrompt" query parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    finalPrompt = translator?.translate(finalPrompt) ?? finalPrompt;

    let events = [];
    if (eventsParam) {
      try {
        events = JSON.parse(eventsParam);
        if (!Array.isArray(events)) {
          throw new Error('Events must be an array');
        }
        // Validate event format
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
    }

    const sytemPromptFromTranslator = translator?.translate("SYSTEM_PROMPT");
    const systemPrompt = (sytemPromptFromTranslator !== "SYSTEM_PROMPT" ? sytemPromptFromTranslator : env.SYSTEM_PROMPT) ?? env.SYSTEM_PROMPT;
    console.log(sytemPromptFromTranslator);
    console.log(systemPrompt);
    // Validate system prompt
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
          'cf-aig-authorization': env.AI_GATEWAY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages,
          max_tokens: 150,
        }),
      });

      if (!response.ok) {
        throw new Error(`AI Gateway error: ${response.status} ${response.statusText}`);
      }

      // Parse response
      const data: any = await response.json();
      const responseText = data.choices[0]?.message?.content || 'No response generated';

      // Return JSON response
      return new Response(JSON.stringify({ response: responseText }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: 'Failed to process request' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
