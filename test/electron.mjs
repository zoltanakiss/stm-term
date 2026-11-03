// Drives the real Electron app with a HIDDEN window (STM_HIDDEN=1): nothing appears on screen.
// Checks the desktop-only behavior: daemon autostart, and drag & drop of a Finder file pasting
// its REAL path (escaped like Terminal.app), not an uploaded copy.
import { _electron as electron } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solidPng } from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-electron-'));
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', 'x-stm': '1' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(200); } return v; };

const shot = path.join(data, 'Screenshot 2026-11-02 at 7.22.50 PM.png'); // spaces, like macOS screenshots
fs.writeFileSync(shot, solidPng());
const app = await electron.launch({
  args: [ROOT],
  env: { ...process.env, STM_HIDDEN: '1', STM_PORT: String(PORT), STM_DATA_DIR: data, STM_TAGGER: 'fake', STM_IMPORT_CLAUDE: '0', STM_INSTALL_CODEX_HOOK: '0' },
});
try {
  const win = await app.firstWindow();
  await win.waitForLoadState();
  check('Electron app starts the daemon and loads the UI (hidden window)', (await until(() => fetch(`${BASE}/api/health`).then((r) => r.ok))) && win.url().startsWith(BASE));
  check('window is hidden (agent QA never takes your screen)', !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())));
  await win.click('[data-testid=new-shell]');
  const tab = await until(async () => (await api('GET', '/api/state')).stm[0]);
  // Wait for the login shell to be ready, then for it to have actually run the setup line.
  await until(async () => /[%$#] $/m.test((await api('GET', `/api/tabs/${tab.id}/text`)).text), 15000);
  await api('POST', `/api/tabs/${tab.id}/input`, { data: "printf '\\033[?2004h'; cat -v\n" });
  await until(async () => /[%$#] printf .*cat -v\n/.test((await api('GET', `/api/tabs/${tab.id}/text`)).text + '\n'), 10000);
  await sleep(300);
  // Disk-backed File objects (what Finder gives you) via a file input, then dispatch a real drop.
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'qa-file'; i.hidden = true; document.body.append(i); });
  await win.setInputFiles('#qa-file', shot);
  await win.evaluate((id) => {
    const dt = new DataTransfer();
    for (const f of document.getElementById('qa-file').files) dt.items.add(f);
    const el = document.querySelector(`.term[data-tab-id="${id}"] .xterm-screen`);
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, tab.id);
  const escaped = shot.replace(/ /g, '\\ ');
  const got = await until(async () => (await api('GET', `/api/tabs/${tab.id}/text`)).text.replace(/\n/g, '').includes(`^[[200~${escaped} ^[[201~`), 6000);
  check('drop of a Finder file pastes its real path, escaped like Terminal', !!got, escaped);
  const uploads = path.join(data, 'uploads');
  check('…and does not upload a copy', !fs.existsSync(uploads) || fs.readdirSync(uploads).length === 0);
  check('window did not navigate away on drop', win.url().startsWith(BASE));
  await win.screenshot({ path: path.join(ROOT, '.qa-artifacts', '08-electron-drop.png') });
} catch (e) { check('electron harness crashed', false, e.stack); }
finally {
  await app.close().catch(() => {});
  await api('POST', '/api/shutdown').catch(() => {}); // the app launched a detached daemon; stop it
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
