// Running packaged editor integration check. All project data stays in a temporary workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '../../../..');
(async () => {
  const { createProject, createColorAsset, createClip } = await import(pathToFileURL(path.join(root, 'packages/vcut/src/project/createProject.ts')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcut-app-check-'));
  const port = 31988, base = `http://127.0.0.1:${port}`;
  const cwd = path.join(root, 'apps/vcut-desktop/release/win-unpacked/resources/vcut');
  let logs = '', browser;
  const server = spawn(process.execPath, ['server.js'], { cwd, windowsHide: true, env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', VEASNA_WORKSPACE_ROOT: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', x => logs += x); server.stderr.on('data', x => logs += x);
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
    assert.ok(ready, logs);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    for (const width of [1440, 390]) {
      const id = `check-${width}`, project = createProject(id, 'Transition integration check');
      project.assets = ['#4267a5', '#b95770', '#49976d'].map(createColorAsset);
      project.sequence.tracks[0].clips = project.assets.map((a, i) => createClip({ assetId: a.id, sourceIn: 0, sourceOut: 1, timelineStart: i }));
      const dir = path.join(tmp, '.vcut', id); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'project.json'); fs.writeFileSync(file, JSON.stringify(project));
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${base}/edit?projectId=${id}`);
      const junctions = page.locator('[data-transition-junction]');
      await junctions.first().waitFor(); assert.equal(await junctions.count(), 2);
      await junctions.first().getByRole('button').click();
      const menu = page.getByRole('menu', { name: 'Transition style' }); await menu.waitFor();
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900, JSON.stringify(box));
      await menu.getByRole('button', { name: 'From previous clip', exact: true }).click();
      await menu.getByRole('menuitem', { name: 'Flash Zoom', exact: true }).click();
      // Save through the actual app shortcut and inspect the persisted model.
      const saved = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor(); return JSON.parse(fs.readFileSync(file, 'utf8')).sequence.tracks[0].clips; };
      let clips = await saved(); assert.equal(clips[1].transitionIn.type, 'flashZoom');
      await menu.getByRole('button', { name: 'Into next clip', exact: true }).click();
      await menu.getByRole('menuitem', { name: 'Zoom Blur', exact: true }).click();
      clips = await saved(); assert.equal(clips[2].transitionIn.type, 'zoomBlur');
      const beforeAll = clips.map(c => c.transitionIn);
      await menu.getByRole('button', { name: 'Apply to every cut on this track', exact: true }).click();
      clips = await saved(); assert.equal(clips[1].transitionIn.type, 'zoomBlur'); assert.equal(clips[2].transitionIn.type, 'zoomBlur');
      await page.keyboard.press('Control+z'); clips = await saved(); assert.deepEqual(clips.map(c => c.transitionIn), beforeAll, 'single undo restores all cuts');
      const oldDuration = clips[2].transitionIn.duration;
      const slider = menu.getByRole('slider'); await slider.scrollIntoViewIfNeeded();
      const sliderBox = await slider.boundingBox();
      await page.mouse.move(sliderBox.x + sliderBox.width * 0.3, sliderBox.y + sliderBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(sliderBox.x + sliderBox.width * 0.7, sliderBox.y + sliderBox.height / 2, { steps: 8 });
      await page.waitForTimeout(500);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sequence.tracks[0].clips[2].transitionIn.duration, oldDuration, 'draft drag must not save');
      await page.mouse.up(); clips = await saved();
      assert.notEqual(clips[2].transitionIn.duration, oldDuration);
      await page.keyboard.press('Control+z'); clips = await saved();
      assert.equal(clips[2].transitionIn.duration, oldDuration, 'one undo restores duration');
      await page.screenshot({ path: path.join(os.tmpdir(), `vcut-app-${width}.png`) });
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: junction opens, popup fits, In/Out target correct neighbors, apply-all and duration drag are one undo, draft is not saved, no browser errors`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    const ended = new Promise(r => server.once('exit', r)); server.kill(); if (server.exitCode === null) await ended;
    const resolved = path.resolve(tmp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('vcut-app-check-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
