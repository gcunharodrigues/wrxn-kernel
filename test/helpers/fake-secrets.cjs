'use strict';

// #70 — runtime-assembled secret-shaped test fixtures (the single source).
//
// WHY: tests must exercise the secret detect/redact paths with real-FORMAT tokens, but a LITERAL
// `xoxb-…`/`AKIA…`/`sk_live_…` in source is flagged by GitHub push protection + GitGuardian purely by
// format — which forced a push-protection bypass to land #39. So every fixture is built at RUNTIME from
// pieces split THROUGH the provider signature (e.g. `'AK' + 'IA' + …`, `'sk' + '_live_' + …`): the
// concatenation produces an exact pattern-matching token at runtime, yet NO contiguous scannable token
// (and no scannable substring) exists in this file's bytes for a static scanner to find. The values are
// fabricated placeholders (the AWS body, for one, is AWS's own published docs example) — never real secrets.
//
// Each builder returns a string that still trips the production scanner/redactor; test/fake-secrets.test.cjs
// proves both halves (every builder still matches a real pattern, and no literal survives under test/).
// node stdlib ONLY, test-only — nothing here ships in payload/manifest.
//
// Shape ↔ canonical production pattern (SECRET_PATTERNS, #39):
//   aws         AKIA[0-9A-Z]{16}
//   github      gh[pousr]_[A-Za-z0-9]{20,}
//   githubPat   github_pat_[A-Za-z0-9_]{22,}
//   slack       xox[baprs]-[A-Za-z0-9-]{10,}
//   openai      sk-[A-Za-z0-9]{20,}
//   openaiProj  sk-proj-[A-Za-z0-9_-]{20,}
//   google      AIza[0-9A-Za-z._-]{10,}
//   stripe      sk_(live|test)_[A-Za-z0-9]{20,}
//   npm         npm_[A-Za-z0-9]{20,}
//   jwt         \bey…\.…\.…\b
//   pemBlock    -----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----
//   pemHeader   -----BEGIN … PRIVATE KEY-----   (lone header fallback)
//   bearer      Bearer\s+[A-Za-z0-9._~+/=-]{20,}
//   keyValue    \b…(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+

// AWS access key id — split through "AKIA". Body is AWS's documented example tail.
const aws = () => 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';

// GitHub token (ghp_/gho_/…) — split "ghp" from "_".
const github = () => 'gh' + 'p_' + '0123456789abcdefghijklmnopqrstuvwxyz';

// GitHub fine-grained PAT — split "github" from "_pat_".
const githubPat = () => 'github' + '_pat_' + '11ABCDEFG0abcdefghijkl_AbCdEf1234567890AbCdEf1234567890';

// Slack bot token (xoxb-…) — split through "xox".
const slack = () => 'xo' + 'xb-' + '1234567890-abcdefABCDEF0987';

// OpenAI-style secret key (sk-…) — split "sk" from "-".
const openai = () => 'sk' + '-' + '0123456789abcdefghijABCDEFGHIJ';

// OpenAI project-scoped key (sk-proj-…) — split "sk" from "-proj-".
const openaiProj = () => 'sk' + '-proj-' + '0123456789abcdef_ABCDEFGHIJ-klmno';

// Google / Gemini API key (AIza…) — split through "AIza".
const google = () => 'AI' + 'za' + 'SyA1B2C3D4E5F6G7H8I9J0kLmNoPqRsTu';

// Stripe live secret key — split "sk" from "_live_".
const stripe = () => 'sk' + '_live_' + '0123456789abcdefghijABCDEFGHIJ';

// npm publish/automation token — split "npm" from "_"; 36-char base62 body.
const npm = () => 'np' + 'm_' + 'a'.repeat(36);

// JWT (three base64url parts) — split each "eyJ…" header through "ey" so no part is a whole JWT.
const jwt = () => 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxIn0' + '.' + 'dummysignature';

// PEM private-key block — split the BEGIN/END boundaries through "PRIV"+"ATE" so no full boundary
// line is contiguous. Body lines carry a redact-probe marker (PEM_BLOCK_BODY) and are not secrets.
const PEM_BLOCK_BODY = 'FAKEKEY' + 'BODYLINEONE' + 'notarealkeymaterial';
const PEM_BLOCK_END = '-----' + 'END RSA PRIV' + 'ATE KEY-----';
const pemBlock = () =>
  [
    '-----BEGIN RSA PRIV' + 'ATE KEY-----',
    PEM_BLOCK_BODY,
    'FAKEKEY' + 'BODYLINETWO' + 'notarealkeymaterial',
    PEM_BLOCK_END,
  ].join('\n');

// Lone/truncated PEM header (no END) — the canonical header-only fallback shape.
const pemHeader = () => '-----BEGIN OPENSSH PRIV' + 'ATE KEY-----';

// Opaque (non-JWT) Bearer token — split "Bearer" through "Bea"+"rer"; opaque body in <20-char pieces.
const bearer = () => 'Bea' + 'rer ' + 'abc123' + 'DEF456ghi789' + 'JKL012mno345';

// KEY=value assignment — split the keyword from "_KEY=" so no contiguous assignment appears in source.
const keyValue = () => 'API' + '_KEY=' + 'NotARealSecretValue123';

module.exports = {
  aws,
  github,
  githubPat,
  slack,
  openai,
  openaiProj,
  google,
  stripe,
  npm,
  jwt,
  pemBlock,
  pemHeader,
  bearer,
  keyValue,
  // redact-probe needles for the PEM block test (decoupled from the block's internals).
  PEM_BLOCK_BODY,
  PEM_BLOCK_END,
};
