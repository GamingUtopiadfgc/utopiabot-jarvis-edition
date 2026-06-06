'use strict';

// Central, capability-aware tool registry. All tool groups are capability-gated;
// no tools are exposed unless the capability is explicitly enabled.
const { FILE_TOOLS, runFileTool, parseToolCall: rawParse } = require('./files');
const { AUTOMATION_TOOLS, runAutomationTool } = require('./automation');
const { VM_TOOLS, runVmTool } = require('./vm');
const { MEMORY_TOOLS, runMemoryTool } = require('./memory');
const { runScript } = require('./coderunner');

const CODE_TOOLS = [
  {
    name: 'write_and_run_code',
    description: [
      "Write a script and submit it to the user's approval queue before running it on the Windows host.",
      'Use this for tasks that need multi-step logic, loops, data processing, or anything beyond a single command.',
      'Supported languages: powershell, python, node, batch.',
      'IMPORTANT: Do NOT echo the code in your text response — the user will see it in the approval block.',
      'After the user approves, the script runs and its output is returned so you can summarise the results.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['powershell', 'python', 'node', 'batch'],
          description: 'Scripting language.',
        },
        code: {
          type: 'string',
          description: 'The complete, runnable script — not a snippet.',
        },
        purpose: {
          type: 'string',
          description: 'One sentence describing what this script does and why.',
        },
      },
      required: ['language', 'code', 'purpose'],
    },
  },
];

async function runCodeTool(name, input, ctx = {}) {
  if (name !== 'write_and_run_code') return `Error: unknown code tool "${name}".`;
  const language = String(input.language || 'powershell').toLowerCase();
  const code     = String(input.code    || '').trim();
  const purpose  = String(input.purpose || '').trim();
  if (!code) return 'No code was provided.';

  // Route to the in-chat approval queue (ctx.approveCode), not the native dialog.
  if (ctx.approveCode) {
    const jobId   = 'code_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const approved = await ctx.approveCode(jobId, code, language, purpose);
    if (!approved) return 'The user denied the script — nothing was executed.';
  }

  return runScript(language, code);
}

const ALL_NAMES = [
  ...FILE_TOOLS, ...AUTOMATION_TOOLS, ...VM_TOOLS, ...MEMORY_TOOLS, ...CODE_TOOLS,
].map((t) => t.name);

const has = (list, name) => list.some((t) => t.name === name);

/** Tool specs the model should see, filtered by capabilities. */
function specs(caps = {}) {
  let list = [];
  if (caps.files)      list = list.concat(FILE_TOOLS);
  if (caps.powershell) list = list.concat(AUTOMATION_TOOLS);
  if (caps.vm)         list = list.concat(VM_TOOLS);
  if (caps.memory)     list = list.concat(MEMORY_TOOLS);
  if (caps.scripting)  list = list.concat(CODE_TOOLS);
  return list;
}

const toClaude = (list) =>
  list.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

const toOllama = (list) =>
  list.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

// Recover a tool call written as text, matching against every known tool name.
const parseToolCall = (text) => rawParse(text, ALL_NAMES);

/** Dispatch a tool by name. ctx carries settings-derived gating + memory. */
async function run(name, input, ctx = {}) {
  if (has(FILE_TOOLS, name))      return runFileTool(name, input);
  if (has(AUTOMATION_TOOLS, name)) return runAutomationTool(name, input, ctx);
  if (has(VM_TOOLS, name))        return runVmTool(name, input, ctx);
  if (has(MEMORY_TOOLS, name))    return runMemoryTool(name, input, ctx);
  if (has(CODE_TOOLS, name))      return runCodeTool(name, input, ctx);
  return `Error: unknown tool "${name}".`;
}

module.exports = { specs, toClaude, toOllama, run, parseToolCall };
