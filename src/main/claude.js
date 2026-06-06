'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./persona');
const { specs, toClaude, run } = require('./tools');

const DEFAULT_MODEL = process.env.JARVIS_MODEL || 'claude-opus-4-8';
const MAX_TOOL_STEPS = 6;

function createBrain() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  /** @type {Anthropic | null} */
  let client = null;
  if (apiKey) {
    client = new Anthropic({ apiKey });
  }

  return {
    status() {
      return {
        configured: Boolean(client),
        model: DEFAULT_MODEL,
      };
    },

    /**
     * One-shot, non-streaming completion. Used for background tasks like
     * memory extraction — no tools, no thinking, small token budget.
     * Returns '' if no API key is configured or on any error.
     * @param {string} prompt
     * @param {{model?: string}} [opts]
     * @returns {Promise<string>}
     */
    async complete(prompt, { model } = {}) {
      if (!client || !prompt) return '';
      try {
        const res = await client.messages.create({
          model: model || DEFAULT_MODEL,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        });
        return (res.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
      } catch {
        return '';
      }
    },

    /**
     * Stream a reply for a multi-turn conversation, running file-access tools
     * as needed (the model can read its own source).
     * @param {Array<{role: 'user'|'assistant', content: any}>} messages
     * @param {{model?: string, onText: (t: string) => void, onDone: (full: string) => void, onError: (m: string) => void, onTool?: (name: string) => void}} cbs
     */
    async streamReply(messages, { model, options = {}, toolCtx = {}, onText, onDone, onError, onTool, onReset }) {
      if (!client) {
        onError(
          'My brain is offline, sir — no API key configured. Add ANTHROPIC_API_KEY to a .env file and restart.'
        );
        return;
      }

      // Custom system prompt overrides the built-in persona when provided;
      // long-term memory context is appended when available.
      let systemText = options.systemPrompt?.trim()
        ? options.systemPrompt
        : SYSTEM_PROMPT;
      if (options.userProfile) systemText += `\n\n${options.userProfile}`;
      if (options.memoryContext)
        systemText += `\n\nThings you remember about the user:\n${options.memoryContext}`;
      const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 4096;
      const toolList = toClaude(specs(toolCtx.caps || {}));
      // Note: temperature/context length aren't sent — Opus 4.8 rejects
      // temperature, and context length isn't a Messages API parameter.

      // Working copy; tool turns get appended here, not in the renderer history.
      const working = messages.map((m) => ({ ...m }));

      try {
        for (let step = 0; step < MAX_TOOL_STEPS; step++) {
          let stepHadText = false;
          const stream = client.messages.stream({
            model: model || DEFAULT_MODEL,
            max_tokens: maxTokens,
            thinking: { type: 'adaptive' },
            system: [
              {
                type: 'text',
                text: systemText,
                cache_control: { type: 'ephemeral' },
              },
            ],
            tools: toolList,
            messages: working,
          });

          stream.on('text', (delta) => { stepHadText = true; onText(delta); });
          const final = await stream.finalMessage();

          if (final.stop_reason === 'tool_use') {
            // Clear any preamble text that streamed before the tool block.
            if (stepHadText) onReset?.();
            working.push({ role: 'assistant', content: final.content });
            const results = [];
            for (const block of final.content) {
              if (block.type === 'tool_use') {
                onTool?.(block.name);
                const out = await run(block.name, block.input, toolCtx);
                results.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: out,
                });
              }
            }
            working.push({ role: 'user', content: results });
            continue; // let the model use the results
          }

          const text = final.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          onDone(text);
          return;
        }
        onError('That took too many steps, sir — I stopped to avoid a loop.');
      } catch (err) {
        // Typed SDK errors carry a clean message; fall back to String().
        const message =
          err instanceof Anthropic.APIError
            ? `Brain error (${err.status}): ${err.message}`
            : err?.message || String(err);
        onError(message);
      }
    },
  };
}

module.exports = { createBrain };
