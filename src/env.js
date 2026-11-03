'use strict';
// Session markers a parent Claude Code process leaks into its children. If tabs inherit them,
// a `claude` started inside a tab thinks it's a sub-session and turns transcript saving off,
// which breaks --resume and transcript-based tagging. User config (e.g. CLAUDE_CODE_USE_BEDROCK) is kept.
const SESSION_MARKER = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|EXECPATH|SSE_PORT|MESSAGING_\w+|SESSION_\w+))$/;
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (SESSION_MARKER.test(k)) delete env[k];
  return { ...env, ...extra };
}
module.exports = { cleanEnv };
