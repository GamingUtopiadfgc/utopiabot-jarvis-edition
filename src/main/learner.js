'use strict';

/**
 * Auto-learning: after a conversation turn, ask the active model to extract
 * durable facts/preferences about the user so JARVIS improves over time
 * without anyone calling the `remember` tool by hand. Dependency-free —
 * reuses whichever brain handled the conversation (Claude or Ollama).
 */

const MAX_FACTS = 5;

function buildPrompt(turn, knownFacts) {
  const known = (knownFacts || [])
    .slice(-40)
    .map((f) => `- ${f}`)
    .join('\n');
  const convo = turn
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  return [
    'You maintain a long-term memory about a single user.',
    'From the exchange below, extract ONLY new, durable facts or preferences',
    'worth remembering for future conversations (e.g. stable preferences,',
    'personal details, recurring goals, tools they use). Write each in the',
    'third person, concisely.',
    '',
    'Rules:',
    '- Do NOT repeat anything already in "Known facts".',
    '- Ignore ephemeral chit-chat, one-off questions, and trivia.',
    '- If nothing is worth saving, return an empty array.',
    `- Return at most ${MAX_FACTS} items.`,
    '- Respond with ONLY a JSON array of short strings, nothing else.',
    '',
    'Known facts:',
    known || '(none)',
    '',
    'Exchange:',
    convo,
    '',
    'JSON array:',
  ].join('\n');
}

/** Pull the first JSON array out of a model response (local models add prose). */
function parseFacts(raw) {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, MAX_FACTS);
  } catch {
    return [];
  }
}

/**
 * Extract durable memories from a turn. Never throws — returns [] on failure.
 * @param {{complete: (p: string, o?: {model?: string}) => Promise<string>}} brain
 * @param {string} model
 * @param {Array<{role: string, content: string}>} turn  last user+assistant exchange
 * @param {string[]} knownFacts
 * @returns {Promise<string[]>}
 */
async function extractMemories(brain, model, turn, knownFacts) {
  try {
    if (!brain?.complete || !turn?.length) return [];
    const raw = await brain.complete(buildPrompt(turn, knownFacts), { model });
    return parseFacts(raw);
  } catch {
    return [];
  }
}

module.exports = { extractMemories };
