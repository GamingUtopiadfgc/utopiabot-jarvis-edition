'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Long-term memory backed by JSON files in the configured folder.
 * Lightweight keyword+recency recall (no vector DB) — good enough to carry
 * facts and preferences across sessions.
 * @param {() => string} [getFolder]
 */
function createMemory(getFolder) {
  const folder = () =>
    (getFolder && getFolder()) || path.join(app.getPath('userData'), 'memory');
  const ensure = () => {
    const f = folder();
    fs.mkdirSync(f, { recursive: true });
    return f;
  };
  const memFile = () => path.join(folder(), 'memories.json');

  function load() {
    try {
      return JSON.parse(fs.readFileSync(memFile(), 'utf8'));
    } catch {
      return [];
    }
  }
  function save(arr) {
    ensure();
    fs.writeFileSync(memFile(), JSON.stringify(arr, null, 2));
  }

  return {
    add(text) {
      if (!text || !text.trim()) return 0;
      const arr = load();
      // Avoid storing near-duplicates.
      if (arr.some((m) => m.text.toLowerCase() === text.trim().toLowerCase()))
        return arr.length;
      arr.push({ text: text.trim(), ts: Date.now() });
      save(arr);
      return arr.length;
    },
    all() {
      return load();
    },
    /** Return a short bullet list of relevant memories to inject as context. */
    getContext(query, limit = 8) {
      const arr = load();
      if (!arr.length) return '';
      const words = String(query || '')
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3);
      const scored = arr.map((m) => {
        const t = m.text.toLowerCase();
        let score = 0;
        for (const w of words) if (t.includes(w)) score++;
        return { m, score };
      });
      const matches = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.m);
      const pick = (matches.length ? matches : arr.slice(-limit)).slice(0, limit);
      return pick.map((m) => `- ${m.text}`).join('\n');
    },
    saveConversation(messages) {
      try {
        ensure();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(
          path.join(folder(), `conversation-${stamp}.json`),
          JSON.stringify(messages, null, 2)
        );
      } catch (err) {
        console.error('saveConversation failed:', err);
      }
    },
  };
}

// Tool the model can call to persist a fact (only offered when long-term
// memory is enabled in Settings).
const MEMORY_TOOLS = [
  {
    name: 'remember',
    description:
      'Save an important fact about the user or context to long-term memory so you can recall it in future conversations. Use when the user shares a preference, a personal detail, or explicitly asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The fact to remember, written concisely in the third person.',
        },
      },
      required: ['fact'],
    },
  },
];

async function runMemoryTool(name, input, ctx = {}) {
  if (name === 'remember') {
    if (!ctx.memory) return 'Long-term memory is disabled, sir.';
    const n = ctx.memory.add(input.fact);
    return n ? "Noted — I'll remember that, sir." : 'Nothing to save.';
  }
  return `Error: unknown memory tool "${name}".`;
}

module.exports = { createMemory, MEMORY_TOOLS, runMemoryTool };
