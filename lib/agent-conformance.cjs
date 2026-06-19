'use strict';

// Agent-contract conformance (wrxn-kernel flow-redesign flow-02).
// A pure transform mirroring lib/executor.cjs: it confirms a native executor subagent definition
// (.claude/agents/<type>.md) is a faithful THIN WRAPPER of the dispatch contract for its type — it
// declares least-privilege tools, a model, and an output contract that EQUALS that type's
// reportSchema (EXECUTORS[type].required). The agent file carries no logic the harness doesn't
// already define, so validateReport's guarantees still hold by construction.
//
// An agent .md declares its output contract in a fenced ```output-contract block in the body — one
// required report field per line. validateAgentFile accepts EITHER the raw markdown (it parses the
// frontmatter + that block) OR a pre-parsed { tools, model, outputContract } object, so it is
// unit-testable without a live LLM.

const { EXECUTORS } = require('./executor.cjs');

/**
 * Parse an agent .md into { name, tools, model, outputContract }.
 *   - frontmatter `tools:` → comma-separated least-privilege allowlist
 *   - frontmatter `model:` → scalar
 *   - the fenced ```output-contract block → one report field per line
 * Tolerant: a missing piece yields an empty value rather than throwing.
 */
function parseAgentFile(markdown) {
  const text = String(markdown || '');
  const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  const fm = fmEnd !== -1 ? text.slice(3, fmEnd) : '';

  const scalar = (key) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  const toolsRaw = scalar('tools');
  const tools = toolsRaw
    ? toolsRaw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // The fenced ```output-contract block (info-string `output-contract`), one field per line; a
  // leading bullet marker is tolerated so the block can read as a list.
  const block = text.match(/```output-contract[^\n]*\n([\s\S]*?)```/);
  const outputContract = block
    ? block[1].split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
    : [];

  return { name: scalar('name'), tools, model: scalar('model'), outputContract };
}

/** Order-independent set-equality over two string arrays (duplicate-safe). */
function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Validate that an executor agent definition conforms to EXECUTORS[type]:
 *   - declares a non-empty `tools` allowlist (least-privilege; presence, not a frozen list —
 *     new MCP tools are valid, per the write-an-agent doctrine),
 *   - declares a `model`,
 *   - its declared output contract EQUALS that type's reportSchema (EXECUTORS[type].required),
 *   - the type is known.
 * `agentDef` may be the raw agent markdown (string) or a pre-parsed
 * { tools, model, outputContract } object. Returns { ok, errors } (mirrors validateReport).
 */
function validateAgentFile(agentDef, type) {
  const def = EXECUTORS[type];
  if (!def) return { ok: false, errors: [`unknown executor type: ${type}`] };

  const parsed = typeof agentDef === 'string' ? parseAgentFile(agentDef) : (agentDef || {});
  const errors = [];

  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  if (tools.length === 0) errors.push('agent declares no tools (a least-privilege allowlist is required)');

  if (!parsed.model || typeof parsed.model !== 'string' || !parsed.model.trim()) {
    errors.push('agent declares no model');
  }

  const declared = Array.isArray(parsed.outputContract) ? parsed.outputContract : [];
  if (!sameSet(declared, def.required)) {
    errors.push(
      `output contract ${JSON.stringify(declared)} does not equal the ${type} reportSchema ${JSON.stringify(def.required)}`
    );
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateAgentFile, parseAgentFile };
