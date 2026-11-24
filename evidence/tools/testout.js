// Runs the three test files and saves their real output as .txt and a rendered .png.
const { chromium } = require('playwright-core');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = require('node:path').resolve(__dirname, '../..'), EVID = ROOT + '/evidence';
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  // Same test files as npm test / test:assignment / test:advanced, with the plain-text TAP reporter.
  for (const [name, file] of [['TEST-starter', 'tests/starter.test.js'], ['TEST-assignment', 'tests/assignment.test.js'], ['TEST-advanced', 'tests/concurrency.test.js']]) {
    const args = ['--test', '--test-reporter=tap', file];
    const r = spawnSync(process.execPath, args, { cwd: ROOT + '/starter', encoding: 'utf8' });
    const out = `PS starter> node --version\n${process.version}\nPS starter> node ${args.join(' ')}\n${r.stdout}${r.stderr}`;
    fs.writeFileSync(`${EVID}/${name}.txt`, out);
    await page.setContent(`<pre style="font:13px/1.45 Consolas,'Malgun Gothic',monospace;background:#0c0c0c;color:#e5e5e5;padding:18px;margin:0;white-space:pre-wrap">${esc(out)}</pre>`);
    await page.screenshot({ path: `${EVID}/${name}.png`, fullPage: true });
    console.log(name, r.status);
  }
  await browser.close();
})();
