// Full-editor crop/resize interaction check using an isolated temporary project.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '../../../..');

(async () => {
  const { createProject, createColorAsset, createClip } = await import(pathToFileURL(path.join(root, 'packages/vcut/src/project/createProject.ts')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcut-crop-check-'));
  const port = 31989, base = `http://127.0.0.1:${port}`;
  const studio = path.join(root, 'studios/vcut');
  let logs = '', browser;
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: studio, windowsHide: true, env: { ...process.env, VEASNA_WORKSPACE_ROOT: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', x => logs += x); server.stderr.on('data', x => logs += x);
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
    assert.ok(ready, logs);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    for (const width of [1440, 390]) {
      const id = `crop-${width}`, project = createProject(id, 'Crop preview check');
      const asset = createColorAsset('#4267a5');
      project.assets = [asset];
      const clip = createClip({ assetId: asset.id, sourceIn: 0, sourceOut: 3, timelineStart: 0 });
      project.sequence.tracks[0].clips = [clip];
      const dir = path.join(tmp, '.vcut', id); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'project.json'); fs.writeFileSync(file, JSON.stringify(project));
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/edit?projectId=${id}`);
      await page.locator('canvas').click({ position: { x: 20, y: 20 }, force: true });
      const cropButton = page.getByRole('button', { name: 'Crop', exact: true }); await cropButton.waitFor();
      const addKeyframe = page.getByRole('button', { name: 'Add keyframe at playhead' });
      await addKeyframe.click(); await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      let saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.equal(saved.transformKeyframes?.length, 1, 'one preview click should add a transform keyframe');
      await page.getByRole('button', { name: 'Remove keyframe at playhead' }).click();
      await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.equal(saved.transformKeyframes, undefined, 'clicking the current diamond again should remove the keyframe');
      const resize = page.getByRole('button', { name: /Resize clip/ }).first();
      await resize.focus(); await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.ok(saved.transform.scale > 1, 'keyboard resize should increase scale');
      await cropButton.click();
      const left = page.getByRole('slider', { name: 'Crop left' }); await left.waitFor();
      const right = page.getByRole('slider', { name: 'Crop right' });
      assert.equal(await page.locator('[role="slider"][aria-label^="Crop "]').count(), 4);
      const rightBefore = await right.boundingBox();
      let box = await left.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
      await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.ok(saved.transform.crop.left > 0, 'preview edge drag should commit crop');
      const rightAfter = await right.boundingBox();
      assert.ok(Math.abs((rightAfter.x + rightAfter.width / 2) - (rightBefore.x + rightBefore.width / 2)) <= 2, 'left crop must keep the right edge fixed');
      await page.keyboard.press('Control+z'); await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.equal(saved.transform.crop.left, 0, 'one undo should restore crop');
      await left.focus(); await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor();
      saved = JSON.parse(fs.readFileSync(file)).sequence.tracks[0].clips[0];
      assert.ok(saved.transform.crop.left > 0, 'keyboard crop adjustment should commit');
      await page.screenshot({ path: path.join(os.tmpdir(), `vcut-crop-${width}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: one-edge crop, four handles, one-click keyframe, keyboard controls, save and single undo`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    const ended = new Promise(resolve => server.once('exit', resolve)); server.kill(); if (server.exitCode === null) await ended;
    const resolved = path.resolve(tmp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('vcut-crop-check-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
