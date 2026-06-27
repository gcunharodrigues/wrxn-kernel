#!/usr/bin/env node
'use strict';

// WRXN chat-search engine — on-demand retrieval over the Conversational log (kernel #83 slice 1, #84 slice 2).
// Self-contained: this ships INTO an install and MUST NOT import the kernel lib (node stdlib only).
//
// It scans BOTH arms of the Conversational log:
//   · the EVENT-LOG arm — <root>/.wrxn/events/*.jsonl, the per-session, pre-redacted user-prompt records
//     emit-event.cjs appends (slice 1);
//   · the HARNESS-TRANSCRIPT arm — ~/.claude/projects/<slug>/*.jsonl, the only source of ASSISTANT turns
//     and full user/assistant message content (slice 2 / #84). Its output is injected-context-stripped +
//     secret-redacted, and a prompt present in both arms is de-duplicated.
// Pure in-process fs scan: no Brain, no embeddings, no recon/serve dependency, no network (ADR 0008). It
// degrades LOUDLY to events-only if the transcript dir is absent/unreadable. Never wired as a per-prompt
// hook — it is invoked deliberately, by the operator or the agent (ADR 0002 boundary).

const fs = require('fs');
const os = require('os'); // home-dir resolution only (the transcript arm lives under ~/.claude/projects) — NOT network/daemon/embedding.
const path = require('path');

// Only prompt records carry text in the event arm, so only they can match. role is derived from kind:
// a user prompt is kind 'prompt' → role 'user'.
function roleFromKind(kind) {
  return kind === 'prompt' ? 'user' : String(kind || '');
}

// A snippet is the matching line plus ±1 line of context within the message text (`needle` is already
// lowercased). A single-line prompt collapses to just that line. A match that only spans a line boundary
// has no single matching line → fall back to the trimmed whole text (defensive; rare).
function snippetFor(text, needle) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
  if (i === -1) return String(text).trim();
  const from = Math.max(0, i - 1);
  const to = Math.min(lines.length - 1, i + 1);
  return lines.slice(from, to + 1).join('\n').trim();
}

// ── render: one hit → "timestamp · session (or 'this session') · role · snippet" ──
// The session column collapses to "this session" when the hit is from the caller's active session
// (opts.session), so a result set reads as scrollback relative to where the operator stands now.
function renderHit(hit, opts) {
  const active = opts && opts.session;
  const sessionLabel = active && hit.session === active ? 'this session' : hit.session;
  return `${hit.ts} · ${sessionLabel} · ${hit.role} · ${hit.snippet}`;
}

// ── locations (injectable — tests pass a temp root) ───────────────────────────
// The events dir for an install root, mirroring emit-event.cjs's eventsDir(root).
function eventsDirOf(root) {
  return path.join(root, '.wrxn', 'events');
}

// Normalize the roots arg to a list of install roots. A string is one root; an array is many. The seam
// stays pure/injectable — it never resolves cwd itself; the CLI passes the resolved root in.
function normalizeRoots(roots) {
  if (!roots) return [];
  return Array.isArray(roots) ? roots : [roots];
}

// Every <sid>.jsonl session log in an events dir. Absent dir → [] (no crash), mirroring wiki.cjs.
function listEventFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// ── injected-context strip (REUSE-by-replication of memory-synth's #62 sentinel-strip) ──────────
// REUSE > ADAPT > CREATE: this is COPIED (mirror, not import) from memory-synth.cjs's stripInjectedContext
// (the slice-1 self-containment convention — the engine replicates findInstallRoot rather than importing,
// and importing memory-synth would transitively pull in https + child_process, breaching the ADR-0008
// no-network/no-daemon boundary this engine's dependency test pins). Hook-injected framework-context
// sentinels — SessionStart's <wrxn-orientation> (which embeds the prior baton), UserPromptSubmit's
// <synapse-rules>/<recall-surface>/<reference-candidate>, and <system-reminder> harness notes — land
// verbatim in the transcript. They are framework noise, not conversation, so a hit inside one is NOT a real
// hit: strip them BEFORE matching. (#62, #84)
const INJECTED_SENTINELS = ['wrxn-orientation', 'synapse-rules', 'recall-surface', 'reference-candidate', 'system-reminder'];
// ReDoS bound (#62): the closed-block strip is ~quadratic on a pathological part (many opens, no closes). A
// real injected block is a few KB; this cap sits far above that yet below the multi-second regex range, so
// the strip stays effectively linear even when the engine scans whole transcripts.
const INJECTED_STRIP_MAX = 65536;

// Strip hook-injected framework-context blocks from one text part BEFORE matching. Two phases: (1) every
// well-delimited <tag>…</tag> block anywhere; (2) a part-LEADING unclosed <tag>… (transcript truncated
// mid-block) to end-of-part — anchored so a sentinel merely MENTIONED mid-prose keeps its tail. PURE and
// FAIL-OPEN: any fault returns the input unchanged. Byte-faithful copy of memory-synth.cjs (#62).
function stripInjectedContext(text) {
  try {
    let out = String(text || '');
    if (out.length > INJECTED_STRIP_MAX) return out; // far larger than any real injected block → ordinary content, nothing part-leading to strip.
    for (const tag of INJECTED_SENTINELS) {
      out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
    }
    for (const tag of INJECTED_SENTINELS) {
      out = out.replace(new RegExp(`^\\s*<${tag}>[\\s\\S]*$`), '');
    }
    return out;
  } catch {
    return String(text || ''); // a filter fault never breaks the scan
  }
}

// ── secret redaction (REUSE-by-replication of the #39 canonical set) ────────────────────────────
// The transcript arm derives output from RAW chat, which can echo a credential the operator/agent pasted.
// Scrub it before any snippet leaves the engine (events are already pre-redacted upstream). The array body
// below is the ONE canonical secret-shape set, kept BYTE-IDENTICAL to its dream/sync/harvest/memory-synth/
// sidecar siblings (drift-pinned by adapter-drift-guard.test.cjs #39) — copied, not imported, for the same
// self-containment reason as stripInjectedContext above. (#39, #84)
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_); {20,} covers the 36-char + CI forms
  /github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style secret key
  /sk-proj-[A-Za-z0-9_-]{20,}/, // OpenAI project-scoped key (underscore form sk-… misses)
  /AIza[0-9A-Za-z._-]{10,}/, // Google / Gemini API key
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/, // Stripe live/test secret key
  /npm_[A-Za-z0-9]{20,}/, // npm publish / automation token
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/, // JWT (incl. Bearer payloads); the eyJ… header gates it
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, // PEM block (FULL — must precede the header fallback so redaction eats the body)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM header (fallback: a lone/truncated header with no END)
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, // opaque Bearer token (non-JWT)
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+/i, // KEY/TOKEN/SECRET/PASSWORD = value
];

// Redaction form: every shape made global so EVERY occurrence is scrubbed (each clone preserves its own
// flags and only ADDS g, so detection and redaction never diverge). Mirrors memory-synth.cjs (#39).
const REDACTIONS = SECRET_PATTERNS.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));

// Redact common secret shapes from `text`, each match → `[REDACTED]`. PURE; ordinary prose is preserved.
function redactSecrets(text) {
  let out = String(text || '');
  for (const re of REDACTIONS) out = out.replace(re, '[REDACTED]');
  return out;
}

// ── harness-transcript arm (#84) ──────────────────────────────────────────────
// The transcript lives OUTSIDE the install, under ~/.claude/projects/<slug>/*.jsonl, where the harness
// derives <slug> from the project's absolute path. The base is injectable (opts.transcriptsHome) so the
// engine is testable without touching the operator's real ~/.claude.
function defaultTranscriptsHome() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Map an install root to its harness transcript dir <home>/<slug>. The slug mirrors how Claude Code names
// ~/.claude/projects/<slug>: every NON-alphanumeric char of the absolute root path → '-' (verified against
// the live dir names). That replacement IS the path-traversal defense — no '/', '\' or '..' can survive it,
// so a crafted root cannot escape the base. The containment check is belt-and-suspenders and ALSO refuses a
// degenerate empty slug that would otherwise resolve to the base itself and read EVERY project's transcripts
// (a cross-project leak). A refusal returns null → the caller degrades loudly to events-only. #84.
function resolveTranscriptDir(root, home) {
  if (!root || !home) return null;
  const base = path.resolve(String(home));
  const slug = String(root).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.resolve(base, slug);
  if (dir === base || !dir.startsWith(base + path.sep)) return null; // must sit STRICTLY under the base — never the base, never outside it.
  return dir;
}

// Every <sid>.jsonl transcript in a project's harness dir. Throws on an absent/unreadable dir — the caller
// catches it to DEGRADE LOUDLY to events-only (so it can tell "arm unavailable" from "arm present, empty").
function listTranscriptFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(dir, n));
}

// Flatten a transcript record's message.content to plain searchable text. Content is a STRING (a plain
// user/assistant message) OR a text-block ARRAY (only the `text` blocks carry conversation — `thinking` /
// `tool_use` / `tool_result` blocks are framework noise, not message content, and are dropped). Any other
// shape → '' (nothing matchable). #84.
function transcriptText(rec) {
  const m = (rec && rec.message) || {};
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

// ── the engine seam ───────────────────────────────────────────────────────────
// searchConversationalLog(query, opts, roots): scan the event-log arm across the given roots' sessions
// and return the prompts whose text contains `query` (case-insensitive substring). Each hit is a
// structured record { ts, session, role, snippet }.
function searchConversationalLog(query, opts, roots) {
  const q = String(query == null ? '' : query);
  const needle = q.toLowerCase();
  const hits = [];
  const seen = new Set(); // a prompt present in BOTH arms (same session+ts+text) must surface only once.
  let degraded = false; // set when the transcript arm could not be consulted → loud events-only degrade (#84).

  // Push a hit when `text` contains the needle and this (session, timestamp, text) triple is new. `text` is
  // the FULL message text already made surface-safe by its arm (events are pre-redacted; transcript turns are
  // injected-stripped + secret-redacted before they reach here), so the snippet it yields is safe to render.
  function consider(ts, session, role, text) {
    if (typeof text !== 'string' || !text.toLowerCase().includes(needle)) return;
    const key = `${session} ${ts} ${text}`; // the AC dedup key — NUL-joined so the parts can't bleed.
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ ts, session, role, snippet: snippetFor(text, needle) });
  }

  for (const root of normalizeRoots(roots)) {
    // ── event-log arm (slice 1): pre-redacted user prompts under <root>/.wrxn/events ──
    for (const file of listEventFiles(eventsDirOf(root))) {
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch {
        continue; // an unreadable entry (EISDIR dir, EACCES, ENOENT/TOCTOU, broken symlink) → skip it, keep scanning
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // skip a malformed line, never crash the scan
        }
        if (!rec || rec.kind !== 'prompt' || typeof rec.text !== 'string') continue; // ONLY prompt records match — a non-prompt (e.g. tool) record is skipped even if it carries a stray text field (#87)
        consider(rec.ts, rec.sid, roleFromKind(rec.kind), rec.text); // events are pre-redacted upstream — pass through as-is.
      }
    }

    // ── harness-transcript arm (#84): assistant turns + full user/assistant message content ──
    const home = (opts && opts.transcriptsHome) || defaultTranscriptsHome();
    const tdir = resolveTranscriptDir(root, home);
    let tfiles = null;
    if (tdir) {
      try {
        tfiles = listTranscriptFiles(tdir); // a present dir yields an array (possibly empty); absent/unreadable throws.
      } catch {
        /* absent / unreadable transcript dir → tfiles stays null → degrade below */
      }
    }
    // tfiles null ⇒ the arm could NOT be consulted (dir refused by the slug guard, or absent/unreadable) →
    // loud events-only degrade. A present-but-empty dir yields [] (arm reachable, simply nothing) → NO degrade.
    if (!tfiles) {
      degraded = true;
    } else {
      for (const file of tfiles) {
        let lines;
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n');
        } catch {
          continue; // an unreadable transcript entry → skip it, keep scanning (never crash)
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue; // skip a malformed transcript line, never crash the scan
          }
          if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) continue; // only user/assistant turns; unknown line types (summary/system/…) skipped
          // hygiene pipeline: flatten → strip injected framework context (a block holding the term is not a
          // hit) → redact secrets (raw chat can echo a credential; scrub BEFORE it can surface in a snippet).
          const text = redactSecrets(stripInjectedContext(transcriptText(rec)));
          consider(rec.timestamp, rec.sessionId, rec.type, text);
        }
      }
    }
  }

  // Recency-first: newest timestamp on top. ISO-8601 stamps parse cleanly; an unparseable ts sorts last.
  hits.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));

  const found = hits.length > 0;
  // Loud degrade (#84): when the transcript arm could not be consulted, say so on its own line so the
  // operator knows results are EVENTS-ONLY (no assistant turns, no full message content) — never silent.
  const head = found
    ? hits.map((h) => renderHit(h, opts)).join('\n')
    : `chat-search: nothing found for "${q}" in the conversational log.`;
  const rendered = degraded
    ? `${head}\nchat-search: transcript arm unavailable — showing event-log results only.`
    : head;

  return { query: q, total: hits.length, found, degraded, hits, rendered };
}

// ── CLI: node .wrxn/chat-search.cjs <term...> [--root <dir>] ──────────────────
// The operator-invocable surface (/chat-search <term>). Resolves the install root by walking up to the
// wrxn.install.json receipt (mirrors wiki.cjs), or honors a --root override (tests). Prints the rendered
// result and exits 0 — a nothing-found result is a normal outcome, never an error exit.

// Mirrors wiki.cjs / emit-event.cjs findInstallRoot (no kernel-lib import in a shipped file).
function findInstallRoot(start) {
  let dir = start || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// Positional search terms: argv from index 2 up to the first --flag.
function positionals() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    out.push(process.argv[i]);
  }
  return out;
}

function main() {
  const terms = positionals();
  if (terms.length === 0) {
    process.stdout.write('Usage: node .wrxn/chat-search.cjs <search-term...> [--root <dir>]\n');
    process.exit(2);
  }
  const root = flag('root') || findInstallRoot();
  if (!root) {
    process.stderr.write('chat-search: cannot resolve the install root — run inside a wrxn install or pass --root <dir>\n');
    process.exit(2);
  }
  // opts is empty here, so the transcript arm uses the default base (~/.claude/projects). The live
  // current-session id (which the renderer collapses to "this session") still has no CLI source — it
  // arrives with the --session flag (#85). Not wired in this slice.
  const result = searchConversationalLog(terms.join(' '), {}, root);
  process.stdout.write(result.rendered + '\n');
  process.exit(0);
}

// Belt-and-suspenders fail-loud (mirrors emit-event.cjs's entrypoint wrap): the per-file read and root
// resolution are already guarded, so main() should not throw — but if any residual fault escapes, exit
// with a clean ONE-LINE diagnostic (a path-free error code only — never a Node stack or absolute path).
if (require.main === module) {
  try {
    main();
  } catch (err) {
    const code = err && err.code ? ` (${err.code})` : '';
    process.stderr.write(`chat-search: search failed unexpectedly${code}\n`);
    process.exit(1);
  }
}

module.exports = { searchConversationalLog, renderHit, resolveTranscriptDir };
