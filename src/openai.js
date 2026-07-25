// Low-level vision->JSON call with model-param compatibility + robust parsing.
import { openai, log } from './config.js';

function buildParams(model, messages, maxTokens) {
  const p = { model, messages, response_format: { type: 'json_object' } };
  if (/^(gpt-5|o[0-9])/.test(model)) {
    // reasoning models: reasoning tokens count against the completion budget, so
    // give a large cap and use low effort to keep cost/latency down.
    p.max_completion_tokens = Math.max(maxTokens, 12000);
    p.reasoning_effort = 'low';
  } else { p.max_tokens = maxTokens; p.temperature = 0.2; }
  return p;
}

function extractJSON(text) {
  if (!text) throw new Error('empty response');
  try { return JSON.parse(text); } catch {}
  // strip code fences / find the outermost {...}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error('no valid JSON in response');
}

// images: array of data-URI or URL strings.
export async function visionJSON({ model, system, user, images = [], maxTokens = 4000, retries = 2 }) {
  const content = [{ type: 'text', text: user }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: img, detail: 'high' } });
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await openai.chat.completions.create(buildParams(model, messages, maxTokens));
      const txt = r.choices?.[0]?.message?.content || '';
      const usage = r.usage || {};
      return { json: extractJSON(txt), usage };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      log(`  [vision] attempt ${attempt + 1} failed: ${msg.slice(0, 140)}`);
      if (attempt < retries) {
        // on JSON/format failure, nudge; on rate limit, back off
        if (/rate|429|timeout|ECONN|overload/i.test(msg)) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        messages.push({ role: 'user', content: 'Your previous reply was not valid JSON. Reply with ONLY the JSON object, no prose, no code fences.' });
      }
    }
  }
  throw lastErr;
}
