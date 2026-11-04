# stm-term

A terminal with **short-term memory** (at most 5 open tabs) and **long-term memory** (a searchable,
Chrome-history-style sidebar). Opening a 6th tab pushes the *stalest* tab into long-term memory, and
Haiku tags it so you can recall later what it was and why it mattered. Clicking a memory brings it back
and pushes the next-stalest tab out.

```bash
npm install
npm run app        # Electron window (starts the daemon if it isn't running)
npm run daemon     # or just the daemon; open http://127.0.0.1:4790 in any browser
npm run stop       # stop the daemon (kills tab processes, snapshots everything first)
npm run qa         # headless QA, isolated daemon, fake tagger (~30s)
STM_QA_REAL=1 npm run qa      # same, with real Haiku tagging
node test/electron.mjs        # the real Electron app, hidden window: autostart + Finder-file drop
node test/claude-tab.mjs      # real Claude tab: task → image drop → evict → tags → close → --resume
```

**Images & files:** drag them onto a tab, as in Terminal/iTerm. In the desktop app the real path is pasted,
backslash-escaped, and as a bracketed paste, so Claude/Codex show `[Image #1]`. `⌘V` with an image on the
clipboard (e.g. a `⌃⇧⌘4` screenshot) saves it to `~/.stm-term/uploads/` and pastes that path; in a plain
browser, drops do the same. `Ctrl+V` still goes straight to the agent. Uploads older than 7 days are pruned
at startup. Agents can do the same with `POST /api/upload?name=x.png&tab=<id>` (raw body).

Keys: `⌘T` shell · `⌘⇧T` Claude · `⌘⌥T` Codex · `⌘W` close · `⌘1–5` switch · `⌘K` search memory.

## Architecture

```
Electron (thin window) ──► http://127.0.0.1:4790  ◄── headless Chromium / curl / agents
                                   │
              daemon (src/server.js, detached, survives window close)
              ├─ node-pty per tab + @xterm/headless mirror (text + serialized snapshot)
              ├─ memory rules: max 5 STM, LRU eviction, restore, close, forget
              ├─ SQLite (node:sqlite) + FTS5 at ~/.stm-term/stm.sqlite
              ├─ conversation index: worker thread → ~/.stm-term/search.sqlite
              └─ tagger: Haiku via `claude -p` (your login) or ANTHROPIC_API_KEY
```

## Decisions (and why)

- **Daemon + web UI, Electron is just a window.** QA runs fully headless in its own Chromium, so it
  never takes your focus. Several QA runs can share the machine (each has its own port and data dir).
- **"Stalest" = least recently focused or typed into by you.** Agent output doesn't count as fresh,
  and input sent through the API doesn't either; only real keystrokes in the UI do.
- **Eviction keeps the process alive.** An evicted agent keeps working (the sidebar shows `● live`).
  An **explicit close (×/⌘W) stops the process**; restoring it then starts a fresh shell with the old
  screen replayed. Claude tabs come back with
  `claude --chrome --dangerously-skip-permissions --resume <session>`.
- **Claude tabs** started from `+ Claude` run `claude --chrome --dangerously-skip-permissions --session-id <uuid>`,
  so the session id is known exactly. A `claude` you start by hand in a shell tab is detected from the
  process tree, and its newest transcript is found under `~/.claude/projects/<cwd-slug>/`.
- **Agents are adapters** (`src/agents/`): Claude Code and Codex. Each one knows how to launch, resume,
  recognize its process, list its sessions, and read a transcript. Adding another agent means adding one file.
- **Codex has no `--session-id` flag**, but it runs Claude-style `SessionStart` hooks that receive the
  session id. stm-term idempotently adds `bin/agent-session-hook.sh` to `~/.codex/hooks.json`, keeping
  any hooks already there; disable with `STM_INSTALL_CODEX_HOOK=0`. The hook does nothing unless
  `$STM_TAB_ID` is set. Inside a tab it records the session for that tab, so `codex resume <id>` is exact,
  and a `codex` started by hand in a shell tab turns that tab into a Codex tab. Codex launches with
  `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`.
- **Your existing agent sessions are imported**: Claude from `~/.claude/projects/*/*.jsonl` and Codex
  from `~/.codex/sessions/**/rollout-*.jsonl`, at startup and every 60s. Only interactive sessions
  (Claude `entrypoint: "cli"`; Codex `codex-tui` from the terminal or VS Code) with at least one human
  message are imported; SDK and background sessions (claude-mem observers, `claude -p`) `codex exec`, subagents, and sessions in temp dirs
  are skipped. The agent's own title (Claude `ai-title`, Codex `session_index.jsonl`) is kept, and the transcript becomes searchable. Haiku
  tags them in the background, newest first, 2 at a time. A session touched in the last 10 minutes shows
  "active elsewhere" (it may be open in another terminal) and is re-tagged only once it goes quiet.
  Forgetting an imported session leaves a tombstone, so the importer doesn't bring it back.
  Disable with `STM_IMPORT_CLAUDE=0`.
- **Search reads whole conversations, not screens.** Every agent session in memory has its transcript
  indexed (`src/search.js`, kept current by a worker thread in `src/index-worker.js`): your messages, the
  agent's replies, and its tool-call inputs (commands, paths, URLs). Tool *outputs* are left out; they're
  most of a transcript's bytes and mostly noise. Each 60 s pass reads only the bytes appended since the
  last pass. On a laptop with 925 sessions (2.5 GB of transcripts) the first pass took 12 s and built a
  124 MB index, and searches answer in 5–500 ms. The index lives in its own file, so deleting
  `search.sqlite` is always safe: it rebuilds on the next start. Disable with `STM_INDEX=0`.
- **Search results are ranked and say why they matched:**
  1. **made**: the session *produced* it. That means a URL it reported in a reply, a branch it created
     or pushed, or a file it wrote, not counting anything you pasted in first. "Which session made this
     link" is one search, and a session where you only pasted the link ranks below it. Only counts when
     specific (5 or fewer sessions match), so a repo name in every file path doesn't swamp the ranking.
  2. **title**: the title, tags or summary match.
  3. **said**: the conversation matches. Sessions with all the words close together come first, then
     sessions with every word somewhere in them. Within each group, sessions where more of the
     conversation matches rank higher, so the session that did the work beats one that mentioned it once.
  4. **screen**: only the last screen matches.

  Each result shows the matching text, highlighted. Without a query, memory is sorted by the later of
  last activity and when the tab left the tab bar, so a tab you just closed is at the top.
- **Tagging input:** title, cwd, git repo and branch, child processes, the last ~120 lines of output and,
  for agent tabs, the transcript (first ask plus recent turns) and what the session produced. Tags are
  re-generated on every eviction. Long sessions drift, so the tagger is told to name the original goal
  (the ticket or feature the first ask named) as well as the current step, and to keep earlier tags
  for that goal. Otherwise a session filed under "gift card refunds" can't be found as the
  "multiple coupons" work it started as.
- **Tagger runs `claude -p --setting-sources project` from an empty temp dir.** That way your user
  hooks (roster, memory, identity minting) don't fire on every tagging call. `--bare` would be cleaner,
  but it requires an API key.
- **Session-marker scrubbing** (`src/env.js`): if the daemon is started from inside Claude Code, its
  `CLAUDE_CODE_CHILD_SESSION` and similar variables would leak into tabs. Claude would then turn
  transcript saving off, which breaks `--resume` and tagging.
- **Existing Claude Code sessions are imported** (`src/importer.js`) from `~/.claude/projects/*/*.jsonl`
  on startup and every 60s. Only interactive sessions (`entrypoint: "cli"`) with a real human message
  are imported; SDK/background sessions and temp-dir sessions are skipped. Claude's own `ai-title` is
  kept as the title. Haiku tags them in the background, 2 at a time, newest first. Sessions touched in
  the last 10 min show "active elsewhere" and are re-tagged only once they settle. Forgetting one
  leaves a tombstone so it isn't re-imported. Disable with `STM_IMPORT_CLAUDE=0`.
- **Security:** binds only to 127.0.0.1, rejects foreign `Host` headers (DNS rebinding), and requires
  an `x-stm: 1` header on mutations (a cross-site POST can't send it without a CORS preflight, which
  is never approved). The WebSocket checks `Origin`.

## Agent-native QA

Every UI action has an API twin, so an agent can check state as data and use pixels only to check layout:

| | |
|---|---|
| `GET /api/state` | short-term tabs, focused id, `nextToEvict` |
| `GET /api/memory?q=&tag=` | long-term items + tag counts; with `q`, ranked, each with `match: {where, text}` |
| `GET /api/health` | includes `index`: sessions indexed, bytes read, whether a pass is running |
| `POST /api/tabs {cwd?, claude?}` | open a tab (may evict) |
| `GET /api/tabs/:id/text?lines=` | plain-text screen of any tab, live or archived |
| `POST /api/tabs/:id/input {data}` | type into a tab (does **not** refresh staleness) |
| `POST /api/tabs/:id/focus` · `/close` | |
| `POST /api/memory/:id/restore` · `/retag` · `DELETE /api/memory/:id` | |

Mutations need the `x-stm: 1` header. For free-form exploring, start an isolated daemon
(`STM_PORT=4811 STM_DATA_DIR=$(mktemp -d) STM_TAGGER=fake npm run daemon`) and point a headless browser
(Playwright MCP, or a script) at it. Never QA against `~/.stm-term`: that's the user's real memory.
UI hooks use `data-testid`: `stm-tab`, `next-evict`, `new-shell`, `new-claude`, `close-tab`,
`ltm-search`, `memory-item`, `mem-tag`, `tag-filter`, `forget`.

Env: `STM_PORT` (4790) · `STM_DATA_DIR` (~/.stm-term) · `STM_MAX` (5) · `STM_TAGGER` (claude|api|fake) ·
`STM_CLAUDE_CMD` · `STM_CODEX_BIN` / `STM_CODEX_CMD` · `STM_SHELL`.

**Tagging failures** (e.g. the Claude CLI mid auto-update) are retried with backoff, then retried
again on daemon restart. A failed item shows "tagging failed · retry" in the sidebar; hover it for the reason.

## License

MIT. See [LICENSE](LICENSE).
