'use strict';

const { SYSTEM_PROMPT } = require('./persona');
const { runTool, toOllamaTools, parseToolCall } = require('./files');

const MAX_TOOL_STEPS = 6;

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Turn common Ollama failures into plain, actionable guidance.
function friendlyOllamaError(detail) {
  const d = String(detail || '');
  if (/out of memory|cudaMalloc|kv cache|failed to allocate|insufficient memory/i.test(d))
    return "That model is too large for your GPU's memory, sir. Pick a smaller model in the Neural Core menu (a 7B–14B model fits a 16GB card), or lower Context Length in Settings, then try again.";
  if (/not found|no such model|try pulling|model .* not/i.test(d))
    return "That model isn't installed. Pull it first with  ollama pull <model>  then hit the rescan button.";
  return null;
}

async function fetchWithTimeout(url, opts = {}, ms = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {() => string} [getHost] returns the current Ollama base URL (from
 * settings). Falls back to the default/env host.
 */
function createOllamaBrain(getHost) {
  const host = () =>
    String((getHost && getHost()) || DEFAULT_HOST).replace(/\/$/, '');

  return {
    /**
     * Probe the local server and list installed models.
     * @returns {Promise<{available: boolean, host: string, models: string[], error?: string}>}
     */
    async status() {
      const HOST = host();
      try {
        const res = await fetchWithTimeout(`${HOST}/api/tags`);
        if (!res.ok) {
          return { available: false, host: HOST, models: [], error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        const models = (data.models || []).map((m) => m.name).sort();
        return { available: true, host: HOST, models };
      } catch (err) {
        const offline =
          err.name === 'AbortError' ||
          /ECONNREFUSED|fetch failed/i.test(err.message || '');
        return {
          available: false,
          host: HOST,
          models: [],
          error: offline ? 'Ollama not reachable' : err.message || String(err),
        };
      }
    },

    /**
     * Get a reply from an Ollama model, running file-access tools as needed.
     * Uses non-streaming turns so tool calls (structured OR text-emitted) are
     * detected reliably and never flash in the UI. The final answer is emitted
     * once via onText, then onDone. Falls back to no-tools if unsupported.
     * @param {Array<{role:'user'|'assistant', content:string}>} messages
     * @param {{model: string, onText:(t:string)=>void, onDone:(full:string)=>void, onError:(m:string)=>void, onTool?:(name:string)=>void}} cbs
     */
    async streamReply(messages, { model, options = {}, onText, onDone, onError, onTool }) {
      if (!model) {
        onError('No Ollama model selected, sir.');
        return;
      }

      const systemText = options.systemPrompt?.trim()
        ? options.systemPrompt
        : SYSTEM_PROMPT;
      // Map UI fields to Ollama's generation options.
      const genOptions = {};
      if (Number.isFinite(options.temperature)) genOptions.temperature = options.temperature;
      if (Number(options.contextLength) > 0) genOptions.num_ctx = Number(options.contextLength);
      if (Number(options.maxTokens) > 0) genOptions.num_predict = Number(options.maxTokens);

      const HOST = host();
      const working = [{ role: 'system', content: systemText }, ...messages];
      let useTools = true;

      try {
        for (let step = 0; step < MAX_TOOL_STEPS; step++) {
          const res = await fetch(`${HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: false,
              messages: working,
              ...(Object.keys(genOptions).length ? { options: genOptions } : {}),
              ...(useTools ? { tools: toOllamaTools() } : {}),
            }),
          });

          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            if (useTools && /tool/i.test(detail)) {
              useTools = false; // model rejects tools — retry without them
              continue;
            }
            onError(
              friendlyOllamaError(detail) ||
                `Ollama error (${res.status}): ${detail || 'no body'}`
            );
            return;
          }

          const data = await res.json();
          if (data.error) {
            onError(friendlyOllamaError(data.error) || `Ollama: ${data.error}`);
            return;
          }

          const msg = data.message || {};
          const content = msg.content || '';

          // Detect a tool call: structured first, then recover one written as
          // text (JSON or Qwen/Hermes XML) — common with local models.
          let calls = null;
          if (msg.tool_calls?.length) {
            calls = msg.tool_calls.map((tc) => ({
              name: tc.function?.name,
              input: tc.function?.arguments || {},
            }));
          } else if (useTools) {
            const parsed = parseToolCall(content);
            if (parsed) calls = [parsed];
          }

          if (calls) {
            working.push({
              role: 'assistant',
              content,
              ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
            });
            for (const c of calls) {
              onTool?.(c.name);
              const input =
                typeof c.input === 'string' ? safeJson(c.input) : c.input;
              const out = await runTool(c.name, input || {});
              working.push({ role: 'tool', name: c.name, content: out });
            }
            continue; // feed results back to the model
          }

          if (content) onText(content);
          onDone(content);
          return;
        }
        onError('That took too many steps, sir — I stopped to avoid a loop.');
      } catch (err) {
        const offline = /ECONNREFUSED|fetch failed/i.test(err.message || '');
        onError(
          offline
            ? `Can't reach Ollama at ${HOST}, sir. Is it running?`
            : `Request failed: ${err.message || String(err)}`
        );
      }
    },
  };
}

module.exports = { createOllamaBrain, DEFAULT_OLLAMA_HOST: DEFAULT_HOST };
