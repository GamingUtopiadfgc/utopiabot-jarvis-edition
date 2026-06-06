'use strict';

// Central, capability-aware tool registry. File tools are always available;
// automation and memory tools are added only when enabled in Settings.
const { FILE_TOOLS, runFileTool, parseToolCall: rawParse } = require('./files');
const { AUTOMATION_TOOLS, runAutomationTool } = require('./automation');
const { VM_TOOLS, runVmTool } = require('./vm');
const { MEMORY_TOOLS, runMemoryTool } = require('./memory');

const ALL_NAMES = [...FILE_TOOLS, ...AUTOMATION_TOOLS, ...VM_TOOLS, ...MEMORY_TOOLS].map(
  (t) => t.name
);
const has = (list, name) => list.some((t) => t.name === name);

/** Tool specs the model should see, filtered by capabilities. */
function specs(caps = {}) {
  let list = [...FILE_TOOLS];
  if (caps.powershell) list = list.concat(AUTOMATION_TOOLS);
  if (caps.vm) list = list.concat(VM_TOOLS);
  if (caps.memory) list = list.concat(MEMORY_TOOLS);
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
  if (has(FILE_TOOLS, name)) return runFileTool(name, input);
  if (has(AUTOMATION_TOOLS, name)) return runAutomationTool(name, input, ctx);
  if (has(VM_TOOLS, name)) return runVmTool(name, input, ctx);
  if (has(MEMORY_TOOLS, name)) return runMemoryTool(name, input, ctx);
  return `Error: unknown tool "${name}".`;
}

module.exports = { specs, toClaude, toOllama, run, parseToolCall };
