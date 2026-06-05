'use strict';

const { SYSTEM_PROMPT } = require('./persona');
const { specs, toOllama, run, parseToolCall } = require('./tools');

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
     * Pull an Ollama model by name. Emits progress via an optional callback.
     * Uses Ollama's streaming pull API so we can report download status.
     * @param {string} modelName e.g. "llama3.2:3b"
     * @param {(status: string) => void} [onProgress] called with progress text
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async pullModel(modelName, onProgress) {
      const HOST = host();
      const report = (msg) => { try { onProgress?.(msg); } catch { /* ignore */ } };
      report(`Pulling ${modelName}…`);

      try {
        const res = await fetch(`${HOST}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName, stream: true }),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return { ok: false, error: friendlyOllamaError(detail) || `Pull failed (${res.status}): ${detail}` };
        }

        // Read the streaming NDJSON response to show progress.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastStatus = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep partial line for next chunk
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              if (chunk.status && chunk.status !== lastStatus) {
                lastStatus = chunk.status;
                report(`${modelName}: ${chunk.status}`);
                if (chunk.total && chunk.completed) {
                  const pct = Math.round((chunk.completed / chunk.total) * 100);
                  report(`${modelName}: ${chunk.status} — ${pct}%`);
                }
              }
              if (chunk.error) {
                return { ok: false, error: friendlyOllamaError(chunk.error) || chunk.error };
              }
            } catch { /* skip malformed lines */ }
          }
        }
        report(`✓ ${modelName} ready`);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Pull request failed: ${err.message || String(err)}` };
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
    /**
     * One-shot, non-streaming completion. Used for background tasks like
     * memory extraction — no tools, low overhead. Returns '' on any error.
     * @param {string} prompt
     * @param {{model?: string}} [opts]
     * @returns {Promise<string>}
     */
    async complete(prompt, { model } = {}) {
      if (!model || !prompt) return '';
      try {
        const res = await fetch(`${host()}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) return '';
        const data = await res.json();
        return data?.message?.content || '';
      } catch {
        return '';
      }
    },

    async streamReply(messages, { model, options = {}, toolCtx = {}, onText, onDone, onError, onTool }) {
      if (!model) {
        onError('No Ollama model selected, sir.');
        return;
      }

      let systemText = options.systemPrompt?.trim()
        ? options.systemPrompt
        : SYSTEM_PROMPT;
      if (options.memoryContext)
        systemText += `\n\nThings you remember about the user:\n${options.memoryContext}`;
      const toolSpecs = toOllama(specs(toolCtx.caps || {}));
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
              ...(useTools && toolSpecs.length ? { tools: toolSpecs } : {}),
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
              const out = await run(c.name, input || {}, toolCtx);
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
