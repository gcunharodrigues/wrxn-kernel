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

// A snippet is the matching line plus ±1 line of context within the message text. `matchesLine` is the
// active matcher (case-insensitive substring by default, or the compiled --regex), so the snippet finds the
// SAME line the scan matched on. A single-line prompt collapses to just that line. A match that only spans a
// line boundary has no single matching line → fall back to the trimmed whole text (defensive; rare).
function snippetFor(text, matchesLine) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => matchesLine(l));
  if (i === -1) return String(text).trim();
  const from = Math.max(0, i - 1);
  const to = Math.min(lines.length - 1, i + 1);
  return lines.slice(from, to + 1).join('\n').trim();
}

// ── render: one hit → "timestamp · session (or 'this session') · role · snippet" ──
// The session column collapses to "this session" when the hit is from the caller's genuinely-LIVE session
// (opts.activeSession — the CLI wires it from CLAUDE_SESSION_ID), so a result set reads as scrollback relative
// to where the operator stands now. This is DECOUPLED from the --session SCOPE filter (opts.session): scoping
// to a PAST session narrows the rows but never relabels them "this session" (#98).
function renderHit(hit, opts) {
  const active = opts && opts.activeSession;
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
// FAIL-OPEN: any fault returns the input unchanged. Logic-identical to memory-synth.cjs's stripInjectedContext
// (#62) — same strip semantics, not a byte-for-byte copy (and the 64KB strip cap is the inherited #62 tradeoff).
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
// sidecar siblings. THIS copy is ENROLLED in adapter-drift-guard.test.cjs's #39 CANON_SITES, so the build
// fails if it ever drifts from the others — copied, not imported, for the same self-containment reason as
// stripInjectedContext above. (#39, #84)
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

// ── slice-3 flags (#85): validation + parsing ──────────────────────────────────
// A user-facing input error. The `userFacing` flag lets the CLI print this message cleanly (one line, no
// Node stack/path) and exit non-zero — the AC's "invalid flag input fails LOUD, never a crash". Bad DATA
// stays fail-soft (skipped, never thrown); only bad INPUT (a flag value) fails loud.
function inputError(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  return e;
}

// Validate a --session id. Scoping is a pure exact-match on each record's session field — the value is NEVER
// used to build a path — so traversal/widening are structurally impossible; this charset guard makes that
// explicit (real session ids are the harness UUIDs + event sids: alnum, hyphen, underscore) and fails LOUD
// on a malformed id rather than silently matching nothing.
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
function validateSession(raw) {
  const s = String(raw);
  if (!SESSION_ID.test(s)) {
    throw inputError(`chat-search: --session value "${raw}" is not a valid session id (expected letters, digits, '-' or '_')`);
  }
  return s;
}

// Parse a --since value into a threshold epoch-ms; a hit survives when its timestamp is >= the threshold.
// Accepts the keyword `today` (start of the current UTC day — record stamps are UTC `…Z`) or an ISO-8601
// date/datetime (via Date.parse). An unparseable value fails LOUD (the AC's invalid-input handling).
function parseSince(raw) {
  const s = String(raw).trim();
  if (s.toLowerCase() === 'today') {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  // N3 (#99): record stamps are UTC, but Date.parse reads an ISO datetime WITH a time component and NO zone
  // designator ("2026-06-26T12:00:00") as MACHINE-LOCAL time — silently shifting the floor by the host offset.
  // Normalize it to UTC by appending Z. A date-only form (no 'T') is already UTC under Date.parse, and an
  // explicit zone (trailing Z or a ±HH[:MM] offset) is honored as written — both pass through untouched.
  const normalized = /[tT]/.test(s) && !/[zZ]$/.test(s) && !/[+-]\d{2}(:?\d{2})?$/.test(s) ? `${s}Z` : s;
  const t = Date.parse(normalized);
  if (Number.isNaN(t)) {
    throw inputError(`chat-search: --since value "${raw}" is not a date — use "today" or an ISO-8601 date (e.g. 2026-06-26)`);
  }
  return t;
}

// ── --regex ReDoS bound ──────────────────────────────────────────────────────
// --regex compiles a USER-supplied pattern and runs it over whole transcripts → classic ReDoS surface. Node
// has no native regex timeout and ADR-0008 forbids a worker/child_process to bound runtime, so the defense is
// STATIC and applied at COMPILE (before any input is matched):
//   (1) PATTERN-LENGTH CAP — a legitimate search pattern is short ("(deploy|ship).*gate", "\\bbaton\\b"); 200
//       chars is generous for real use yet bounds how much quantifier nesting an adversarial pattern can pack.
//   (2) NESTING-AWARE CATASTROPHIC-SHAPE SCREEN (isCatastrophicRegex) — reject a *quantified group* whose
//       body, through ANY nesting depth, repeats or alternates (a quantifier + * { ? or an alternation |).
//       This is the catastrophic-backtracking (star-height ≥ 2 / overlapping-alternation-under-a-quantifier)
//       family — both FLAT (a+)+, (a|a)+, (?:a*)* AND the NESTED forms a flat regex screen misses because it
//       cannot cross an inner paren: ((a)+)+ (the OWASP example), ((a+))+, ((\w)+)+$, (a(b+)c)+, (a{1,5})+.
//       Plus backreferences (\1..\9), which can backtrack catastrophically — refused outright.
//   (3) ADJACENT-QUANTIFIER COUNT CAP (#96) — the screen in (2) models *grouped* shapes, so it ACCEPTS a flat
//       run of adjacent unbounded quantifiers with no group: a+a+a+…$ (the named residual). That run still
//       backtracks catastrophically on a long single-char line (security F2: hung the real CLI >10s), so as
//       cheap defense-in-depth isCatastrophicRegex ALSO counts unbounded quantifiers (+ * {n,} — the {n,m}/{n}
//       bounded forms and the 0-or-1 ? are excluded) and refuses a pattern that packs more than the cap. Every
//       reviewed safe pattern uses ≤1; the cap leaves generous headroom for a rich multi-segment search yet
//       kills the dozens-deep pileup (the 200-char length cap (1) fits ~66 a+).
// It is deliberately CONSERVATIVE: it also rejects the rare-but-safe outer-quantified alternation (foo|bar)+
// (drop the outer quantifier to search it). It does NOT over-reject ordinary grouping — (foo|bar), (ab)+,
// ([a+])+, (?:ab)+, a{1,5}, \d{4}-\d{2}-\d{2} all pass.
// RESIDUAL (stated honestly): a STATIC screen cannot be airtight under the no-timeout/ADR-0008 constraint —
// it models group/quantifier structure, not match semantics, so it cannot prove a pattern safe, only refuse
// the known-dangerous shapes. The catastrophic families that actually occur (flat + nested star-height-2,
// overlapping alternation under a quantifier, the flat adjacent-quantifier run a+a+a+…, backreferences —
// incl. every reviewed probe) are refused at compile before any input is matched. The count cap (3) bounds
// the NUMBER of unbounded quantifiers, not the per-quantifier blowup an allowed handful can still cause over
// an arbitrarily long single-char line — that narrow polynomial residual is the disclosed cost of the
// no-timeout constraint; an exotic construct outside the modelled shapes and the cap is likewise not proven safe.
const REGEX_PATTERN_MAX = 200;
// Cap on the count of unbounded quantifiers (+ * {n,}) — see defense layer (3) above (#96).
const REGEX_UNBOUNDED_QUANTIFIER_MAX = 10;

// Linear (O(pattern length)) structural scan: does `p` contain a quantified group whose body repeats or
// alternates at any nesting depth, a backreference, OR more than the cap of adjacent unbounded quantifiers
// (the flat a+a+a+…$ residual, #96)? Tracks one frame per open group; `complex` = the group's body holds a
// quantifier/alternation (bubbled up from descendants), so a quantifier on the group's `)` makes it
// catastrophic. In the SAME pass it counts unbounded quantifiers (+ * and the open-ended {n,} — bounded
// {n}/{n,m} and the 0-or-1 ? are NOT unbounded) regardless of nesting depth and refuses a pileup over the
// cap. Skips escapes (\w, \(, …) and char-class interiors ([a+]) where metachars are literal, and the `?` of
// a group prefix ((?:, (?=, (?<…), which is not a quantifier.
function isCatastrophicRegex(p) {
  const stack = [];
  let unbounded = 0; // count of unbounded quantifiers (+ * {n,}) at any depth — the adjacent-quantifier cap (#96)
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      const n = p[i + 1];
      if (n >= '1' && n <= '9') return true; // backreference → refuse
      i++; // skip the escaped atom — never structural
      continue;
    }
    if (c === '[') { // character class: every metachar inside is a literal
      i++;
      if (p[i] === '^') i++;
      if (p[i] === ']') i++; // a leading ] is a literal member
      while (i < p.length && p[i] !== ']') {
        if (p[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') {
      stack.push({ complex: false });
      if (p[i + 1] === '?') i++; // group prefix ((?:, (?=, (?<…) — its ? is not a quantifier
      continue;
    }
    if (c === ')') {
      const f = stack.pop() || { complex: false };
      const q = p[i + 1];
      if ((q === '+' || q === '*' || q === '?' || q === '{') && f.complex) return true; // quantified group, repeating body
      if (stack.length) stack[stack.length - 1].complex = stack[stack.length - 1].complex || f.complex; // bubble up any depth
      continue;
    }
    if (c === '|' || c === '+' || c === '*' || c === '?' || c === '{') {
      // count unbounded quantifiers at ANY depth so a flat top-level run (a+a+a+…) is bounded too (#96):
      // + and * are always unbounded; {n,} is unbounded only when a `}` immediately follows the comma.
      if (c === '+' || c === '*') unbounded++;
      else if (c === '{' && /^\{\d+,\}/.test(p.slice(i))) unbounded++;
      if (stack.length) stack[stack.length - 1].complex = true; // a quantifier/alternation token in the current group's body
    }
  }
  if (unbounded > REGEX_UNBOUNDED_QUANTIFIER_MAX) return true; // adjacent-quantifier pileup (a+a+a+…$) — defense-in-depth (#96)
  return false;
}

// Compile a user-supplied --regex pattern. Case-sensitive, no g/y flag, so .test() is stateless across the
// thousands of calls the scan makes. A too-long / catastrophic / malformed pattern fails LOUD (the AC's
// invalid-input handling) — the operator sees one clean line, never a stack or a multi-second hang.
function compileUserRegex(pattern) {
  const p = String(pattern);
  if (p.length > REGEX_PATTERN_MAX) {
    throw inputError(`chat-search: --regex pattern too long (max ${REGEX_PATTERN_MAX} chars)`);
  }
  if (isCatastrophicRegex(p)) {
    throw inputError('chat-search: --regex pattern rejected — a quantified group whose body repeats or alternates, a long run of adjacent unbounded quantifiers (a+a+a+…), or a backreference risks catastrophic backtracking (ReDoS); simplify the pattern');
  }
  try {
    return new RegExp(p);
  } catch (err) {
    throw inputError(`chat-search: --regex pattern is not a valid regular expression (${err.message})`);
  }
}

// ── cross-arm dedup identity (#97) ─────────────────────────────────────────────
// The SAME prompt reaches both arms stamped by DIFFERENT processes: emit-event.cjs writes the event ts at
// hook-fire, the harness writes the transcript timestamp when it persists the turn — they differ by ms — and
// the transcript text can differ from the event text by whitespace (hygiene strip, soft-wrap). So the dedup
// identity is (session, whitespace-normalized text, ts within a TIGHT ±window), NOT an exact triple. The
// window is 2s: a single turn's two stamps land within ~1s in practice, while two genuinely-distinct prompts
// are seconds-to-minutes apart AND (almost always) differ in text — so the window only ever collapses what is
// really one turn. The normalized text is the primary discriminator; the window only absorbs the writer
// clock-skew on an otherwise-identical turn (two distinct prompts inside the window keep their distinct text,
// so they never merge; the same text outside the window stays two distinct moments).
const DEDUP_WINDOW_MS = 2000;
// Normalize a message's text for the dedup key: trim the ends and collapse every interior whitespace run
// (spaces, tabs, newlines) to a single space, so an event/transcript pair that differs only in spacing keys alike.
function normalizeForDedup(text) {
  return String(text).trim().replace(/\s+/g, ' ');
}

// ── the engine seam ───────────────────────────────────────────────────────────
// searchConversationalLog(query, opts, roots): scan BOTH arms across the given roots' sessions and return
// the turns that match `query` — a case-insensitive substring by default, or (opts.regex) the compiled
// pattern. opts also carries the slice-3 filters: opts.session scopes to one session, opts.since is a
// timestamp floor; both are applied per-record so they compose with the arms, recency, and dedup. A bad
// flag value (invalid/catastrophic regex, unparseable --since, unsafe --session) throws a user-facing
// error (fail loud). Each hit is a structured record { ts, session, role, snippet }.
function searchConversationalLog(query, opts, roots) {
  const q = String(query == null ? '' : query);
  const needle = q.toLowerCase();
  const hits = [];
  const seen = new Map(); // dedup index (#97): `${session} ${normText}` → [{ tsMs, ts }] already surfaced; a near-stamp match collapses cross-arm duplicates.
  let degraded = false; // set when the transcript arm could not be consulted → loud events-only degrade (#84).

  // ── slice-3 filters (#85): each is an opts field applied per-record inside consider(), so it composes
  // automatically with BOTH arms, the recency sort, and the cross-arm dedup. --session scopes to one session. ──
  const sessionScope = opts && opts.session != null ? validateSession(opts.session) : null;
  const sinceThreshold = opts && opts.since != null ? parseSince(opts.since) : null; // --since: epoch-ms floor
  const useRegex = !!(opts && opts.regex);
  const re = useRegex ? compileUserRegex(q) : null; // --regex: compile once (throws loud on a bad/dangerous pattern)
  // The one matcher used for BOTH the whole-text scan gate and the per-line snippet — substring or regex.
  const lineMatches = useRegex ? (s) => re.test(String(s)) : (s) => String(s).toLowerCase().includes(needle);

  // Push a hit when `text` contains the needle and this (session, timestamp, text) triple is new. `text` is
  // the FULL message text already made surface-safe by its arm (events are pre-redacted; transcript turns are
  // injected-stripped + secret-redacted before they reach here), so the snippet it yields is safe to render.
  function consider(ts, session, role, text) {
    if (sessionScope != null && session !== sessionScope) return; // --session: exact-match a single session
    if (typeof text !== 'string' || !lineMatches(text)) return; // --regex pattern, else case-insensitive substring
    if (sinceThreshold != null && !(Date.parse(ts) >= sinceThreshold)) return; // --since: drop hits before the floor (an undatable ts → NaN → dropped)
    // Cross-arm dedup (#97): same session + whitespace-normalized text + a ts within the tight window = the
    // same turn → surface once. NUL-joined so session and text can't bleed. An undatable or exactly-equal
    // stamp falls back to ts-string equality, so an unparseable ts still collapses its exact twin.
    const key = `${session} ${normalizeForDedup(text)}`;
    const tsMs = Date.parse(ts);
    const prior = seen.get(key);
    if (prior) {
      const dup = prior.some(
        (e) => (Number.isFinite(tsMs) && Number.isFinite(e.tsMs) && Math.abs(e.tsMs - tsMs) <= DEDUP_WINDOW_MS) || e.ts === ts,
      );
      if (dup) return; // a near-identical turn from the other arm (or an exact twin) already surfaced
      prior.push({ tsMs, ts });
    } else {
      seen.set(key, [{ tsMs, ts }]);
    }
    hits.push({ ts, session, role, snippet: snippetFor(text, lineMatches) });
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
      let recognizedTurns = 0; // user/assistant turns this dir yielded; zero across a non-empty dir = wholesale drift (#99 F3)
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
          recognizedTurns++; // a recognized turn (matchable or not) → this dir is NOT wholesale-drifted (#99 F3)
          // hygiene pipeline: flatten → strip injected framework context (a block holding the term is not a
          // hit) → redact secrets (raw chat can echo a credential; scrub BEFORE it can surface in a snippet).
          const text = redactSecrets(stripInjectedContext(transcriptText(rec)));
          consider(rec.timestamp, rec.sessionId, rec.type, text);
        }
      }
      // F3 (#99): a present, readable dir whose EVERY line is an unknown type yielded zero usable turns — the
      // arm is effectively unavailable → loud events-only degrade. Per-RECORD drift (some good turns) stays
      // silent, and a present-but-empty dir ([]) is reachable-but-nothing and stays silent, both as before.
      if (tfiles.length > 0 && recognizedTurns === 0) degraded = true;
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

// ── CLI: node .wrxn/chat-search.cjs <term...> [--root <dir>] [--session <id>] [--since <when>] [--regex] ──
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

// Value of a --name <value> flag, or undefined when the flag is ABSENT (optional). A PRESENT flag whose value
// is missing or is itself a --flag fails LOUD (N2, #99) — parity with `--session ""`, never a silent
// scope-widening drop: so `--session --regex` can't swallow --regex as the id and a trailing `--since` can't
// vanish. The throw is userFacing, so main()'s catch prints one clean line and exits non-zero.
function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const val = process.argv[i + 1];
  if (val == null || val.startsWith('--')) throw inputError(`chat-search: --${name} requires a value`);
  return val;
}

// Presence of a boolean --name flag (e.g. --regex), which carries no value.
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
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
    process.stdout.write('Usage: node .wrxn/chat-search.cjs <search-term...> [--root <dir>] [--session <id>] [--since <when>] [--regex]\n');
    process.exit(2);
  }
  // Flag parsing AND the engine call live inside ONE user-facing try: a value-flag with a missing/--prefixed
  // value (flag(), N2 #99) and a bad regex / unparseable --since (the engine) both throw a clean userFacing
  // error → the catch prints that one line and exits non-zero (never a Node stack or absolute path).
  try {
    const root = flag('root') || findInstallRoot();
    if (!root) {
      process.stderr.write('chat-search: cannot resolve the install root — run inside a wrxn install or pass --root <dir>\n');
      process.exit(2);
    }
    // Wire the slice-3 flags (#85) into engine opts.
    const opts = {};
    const session = flag('session');
    if (session !== undefined) opts.session = session;
    const since = flag('since');
    if (since !== undefined) opts.since = since;
    if (hasFlag('regex')) opts.regex = true;
    // The "this session" label tracks the genuinely-LIVE session (Claude Code exports CLAUDE_SESSION_ID), NOT
    // the --session SCOPE filter — so scoping to a PAST session never relabels its rows "this session" (#98).
    const activeSession = process.env.CLAUDE_SESSION_ID;
    if (activeSession) opts.activeSession = activeSession;

    const result = searchConversationalLog(terms.join(' '), opts, root);
    process.stdout.write(result.rendered + '\n');
    process.exit(0);
  } catch (err) {
    if (err && err.userFacing) {
      // invalid flag input (missing flag value, bad/catastrophic regex, unparseable --since): fail LOUD with
      // the one clean line — never a Node stack or path — and exit non-zero (usage error).
      process.stderr.write(err.message + '\n');
      process.exit(2);
    }
    throw err; // an unexpected fault → the entrypoint wrap turns it into a clean path-free diagnostic
  }
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
