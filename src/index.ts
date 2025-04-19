interface Env {
  OPENAI_API_KEY: string;
  SYSTEM_PROMPT: string;
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Ensure it's a GET request
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Extract query parameters
    const url = new URL(request.url);
    const eventsParam = url.searchParams.get('events');
    const finalPrompt = url.searchParams.get('finalPrompt');

    // Validate parameters
    if (!finalPrompt) {
      return new Response(JSON.stringify({ error: 'Missing "finalPrompt" query parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

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
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: `Invalid "events" format: ${error.message}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Validate system prompt
    if (!env.SYSTEM_PROMPT) {
      return new Response(JSON.stringify({ error: 'System prompt not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      // Construct message array
      const messages = [
        { role: 'system', content: env.SYSTEM_PROMPT },
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
