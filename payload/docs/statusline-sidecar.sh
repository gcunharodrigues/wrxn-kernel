#!/usr/bin/env bash
# WRXN SYNAPSE statusline sidecar — the live context-window writer.
#
# Why: UserPromptSubmit hooks (where SYNAPSE runs) receive no model/context-window data, so the
# handoff math cannot tell a 200k session from a 1M one. The statusline IS handed the live window
# (context_window.context_window_size) on stdin every render — so we publish it to a session-scoped
# temp file that the synapse-engine hook reads back (readStatuslineWindow → .context_window_size).
# The temp dir MUST match the reader's os.tmpdir() — both honor $TMPDIR, falling back to /tmp.
#
# How to enable: paste the marker-bounded block below into your Claude Code statusline script, OR run
#   wrxn statusline --inject [--path <your-statusline-script>]
# which appends it idempotently. It NEVER overwrites your statusline — append-only, marker-guarded.
#
# Assumptions the block makes about the host statusline:
#   - $input        the raw statusline stdin JSON (most statuslines do `input=$(cat)` at the top).
#   - $session_id   the session id (e.g. `session_id=$(echo "$input" | jq -r '.session_id')`).
# If your statusline lacks these, set them above the block. The block fails safe regardless: the write
# is guarded by `2>/dev/null || true`, so a missing tool or var can never break your statusline render.

# >>> wrxn sidecar >>>
# UserPromptSubmit hooks receive NO model/context-window data, so SYNAPSE's handoff math can't tell
# a 200k session from a 1M one. Publish the live window to a session-scoped file the hook reads.
# Refreshed every render → tracks a mid-session /model switch.
if [[ -n "$session_id" ]]; then
    cw_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
    [[ -z "$cw_size" || "$cw_size" == "null" ]] && { [[ "$(echo "$input" | jq -r '.model.id // ""')" == *"[1m]"* ]] && cw_size=1000000 || cw_size=200000; }
    printf '{"context_window_size":%s,"model_id":"%s"}\n' "$cw_size" "$(echo "$input" | jq -r '.model.id // ""')" \
        > "${TMPDIR:-/tmp}/claude-statusline-ctx-${session_id}.json" 2>/dev/null || true
fi
# <<< wrxn sidecar <<<
