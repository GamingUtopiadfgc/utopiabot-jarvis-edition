'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { app } = require('electron');

// Sandbox root: the project directory (where package.json lives).
function root() {
  return app.getAppPath();
}

// Never expose secrets or huge/irrelevant trees.
const BLOCKED = new Set(['.env', '.git', 'node_modules', 'dist']);
const MAX_READ = 60000; // chars

/**
 * Resolve a user-supplied relative path and guarantee it stays inside root.
 * Throws on traversal or blocked locations.
 */
function safeResolve(rel) {
  const base = root();
  const target = path.resolve(base, rel || '.');
  const relFromBase = path.relative(base, target);
  if (relFromBase.startsWith('..') || path.isAbsolute(relFromBase)) {
    throw new Error('Path is outside the project, sir. Access denied.');
  }
  // Block secret/irrelevant segments anywhere in the path.
  for (const seg of relFromBase.split(path.sep)) {
    if (BLOCKED.has(seg)) {
      throw new Error(`"${seg}" is off-limits.`);
    }
  }
  return target;
}

async function listDir(rel) {
  const dir = safeResolve(rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const lines = entries
    .filter((e) => !BLOCKED.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const shown = rel && rel !== '.' ? rel : '(project root)';
  return `Contents of ${shown}:\n` + (lines.join('\n') || '(empty)');
}

async function readFile(rel) {
  if (!rel) throw new Error('No file path given.');
  const file = safeResolve(rel);
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) {
    throw new Error(`${rel} is a directory — use list_files instead.`);
  }
  let text = await fsp.readFile(file, 'utf8');
  let note = '';
  if (text.length > MAX_READ) {
    text = text.slice(0, MAX_READ);
    note = `\n\n[...truncated at ${MAX_READ} characters]`;
  }
  return `--- ${rel} ---\n${text}${note}`;
}

/**
 * Execute a tool by name. Always resolves to a string (errors included) so the
 * model can recover gracefully.
 */
async function runTool(name, input = {}) {
  try {
    if (name === 'list_files') return await listDir(input.path);
    if (name === 'read_file') return await readFile(input.path);
    return `Error: unknown tool "${name}".`;
  } catch (err) {
    return `Error: ${err.message || String(err)}`;
  }
}

// Canonical tool specs, adapted per provider below.
const TOOLS = [
  {
    name: 'list_files',
    description:
      "List files and folders inside the UtopiaBot project — your own source code. Path is relative to the project root; omit it or pass '.' for the root. Use this to discover what files exist before reading one.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory, e.g. "src/main". Optional.',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description:
      "Read the contents of one of your own source files. Path is relative to the project root, e.g. 'src/main/claude.js'. Use this when asked about your code, configuration, or how you work.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path, e.g. "src/renderer/reactor.js".',
        },
      },
      required: ['path'],
    },
  },
];

/**
 * Best-effort recovery of a tool call from a model that emitted it as plain
 * text/JSON instead of a structured tool_call (common with local models).
 * Returns { name, input } or null. Conservative — only fires on a JSON object
 * whose name matches a real tool.
 */
function parseToolCall(text) {
  if (!text) return null;
  const names = TOOLS.map((t) => t.name);
  const candidates = [];

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(text))) candidates.push(m[1]);

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    let obj;
    try {
      obj = JSON.parse(c.trim());
    } catch {
      continue;
    }
    const call = Array.isArray(obj) ? obj[0] : obj;
    if (!call || typeof call !== 'object') continue;
    const name = call.name || call.tool || call.function?.name;
    let args =
      call.arguments || call.parameters || call.args || call.function?.arguments || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (names.includes(name)) return { name, input: args };
  }

  // Qwen/Hermes XML style: <function=read_file><parameter=path>...</parameter>
  const fn = text.match(/<function\s*=\s*([\w-]+)\s*>([\s\S]*?)(?:<\/function>|<\/tool_call>|$)/i);
  if (fn && names.includes(fn[1])) {
    const input = {};
    const pre = /<parameter\s*=\s*([\w-]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let p;
    while ((p = pre.exec(fn[2]))) input[p[1]] = p[2].trim();
    return { name: fn[1], input };
  }

  return null;
}

const toClaudeTools = () =>
  TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

const toOllamaTools = () =>
  TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

module.exports = { runTool, toClaudeTools, toOllamaTools, parseToolCall };
