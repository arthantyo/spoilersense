import { settings } from '@devvit/web/server';

// Returns the raw string response from the chosen LLM provider (OpenAI or
// Gemini). The caller is responsible for parsing/coercing the JSON.
export const callLlm = async (
  content: any,
  apiKey: string,
  model: string
): Promise<string> => {
  const provider = (
    (await settings.get<string[]>('spoilerLlmProvider'))?.[0] || 'openai'
  ).toLowerCase();

  const system =
    'You are a Reddit spoiler moderation classifier. Return JSON only, no markdown. Treat speculation, theories, and predictions as non-spoilers unless the text states confirmed plot details.';

  const payloadObj = {
    task: 'Classify spoiler risk for this Reddit content.',
    schema: {
      risk_level: 'LOW | MEDIUM | HIGH',
      spoiler_type:
        'none | hint | episode_spoiler | character_death | major_plot',
      visibility_risk: 'low | medium | high',
      recommended_action:
        'allow | warn_user | collapse | send_to_modqueue | remove',
      reasoning: 'short explanation',
    },
    content: {
      kind: content.kind,
      subredditName: content.subredditName,
      title: content.title,
      body: content.body,
    },
    policy: [
      'If uncertain, choose the safer of two neighboring levels.',
      'Use remove only for severe explicit spoilers or repeated direct reveal style text.',
      'Use send_to_modqueue for medium/high visibility risk spoilers.',
      'If the text is framed as a theory, prediction, or guess, do not classify it as a spoiler unless it reveals confirmed details.',
    ],
  };

  const userMessage = JSON.stringify(payloadObj);

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) throw new Error(`OpenAI request failed ${res.status}`);
    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content ?? '';
    if (!raw || !String(raw).trim()) {
      throw new Error('OpenAI returned empty response');
    }
    return String(raw);
  }

  // Gemini / Google Generative Language fallback path. We send a single
  // prompt and return the raw text body for parsing by the caller. Exact
  // endpoint/format may vary by deployment; this is a best-effort
  // implementation that expects the provider to return a plain text body
  // containing the JSON object.
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(
    model
  )}:generateText`;

  const res = await fetch(geminiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: `${system}\n\n${userMessage}`,
      temperature: 0,
    }),
  });

  if (!res.ok) throw new Error(`Gemini request failed ${res.status}`);
  // Some Gemini endpoints return structured JSON, others plain text. Read
  // as text and return -- caller will attempt to parse a JSON object.
  const text = await res.text();
  if (!text || !text.trim()) throw new Error('Gemini returned empty response');
  return text;
};

export default callLlm;
