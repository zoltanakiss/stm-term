#!/bin/sh
# SessionStart hook (Codex, and any Claude-style hook system). No-op outside stm-term.
# Inside an stm-term tab, records which agent session the tab started, keyed by $STM_TAB_ID,
# so stm-term can resume exactly that session later.
[ -n "$STM_TAB_ID" ] || exit 0
dir="${STM_SESSIONS_DIR:-$HOME/.stm-term/agent-sessions}"
mkdir -p "$dir" && cat > "$dir/$STM_TAB_ID.${1:-agent}.json"
exit 0
