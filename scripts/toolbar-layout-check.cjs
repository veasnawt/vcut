// Full-editor toolbar layout check with an isolated temporary project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const studio = path.join(root, 'studios/vcut');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const port = 31991;
const base = `http://127.0.0.1:${port}`;

async function layout(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('.vcut-toolbar');
    const workspace = document.querySelector('.vcut-workspace');
    const media = document.querySelector('.vcut-media-panel');
    const preview = document.querySelector('canvas');
    const timeline = workspace.querySelector('[class*="row-start-2"]');
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      direction: getComputedStyle(rail).flexDirection,
      workspaceColumns: getComputedStyle(workspace).gridTemplateColumns.split(' ').map(Number.parseFloat),
      rail: rect(rail), workspace: rect(workspace), preview: rect(preview), timeline: rect(timeline),
      mediaVisible: getComputedStyle(media).display !== 'none',
      preference: localStorage.getItem('vcut-toolbar-position'),
      rootPreference: document.documentElement.dataset.vcutToolbarPosition,
    };
  });
}

(async () => {
  const { createProject, createColorAsset, createClip } = await import(pathToFileURL(path.join(root, 'packages/vcut/src/project/createProject.ts')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcut-toolbar-check-'));
  const id = 'toolbar-layout', project = createProject(id, 'Toolbar layout check');
  const asset = createColorAsset('#4267a5');
  project.assets = [asset];
  project.sequence.tracks[0].clips = [createClip({ assetId: asset.id, sourceIn: 0, sourceOut: 3, timelineStart: 0 })];
  const dir = path.join(tmp, '.vcut', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  const otherId = 'toolbar-other', otherDir = path.join(tmp, '.vcut', otherId);
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'project.json'), JSON.stringify(createProject(otherId, 'Other toolbar project')));
  let logs = '', browser;
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: studio, windowsHide: true, env: { ...process.env, VEASNA_WORKSPACE_ROOT: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', x => logs += x); server.stderr.on('data', x => logs += x);
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ready, logs);
    browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/edit?projectId=${id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.vcut-toolbar-tools button');
    let state = await layout(page);
    assert.equal(state.direction, 'column', 'new desktop users should get a left toolbar');
    assert.equal(state.rail.width, 56);
    assert.ok(Math.abs(state.workspace.x - (state.rail.x + 56)) < 1);
    assert.equal(state.mediaVisible, false, 'media panel should begin collapsed in left mode');
    assert.ok(state.preview.width > 0 && state.preview.height > 0);
    assert.ok(state.timeline.y >= state.preview.y + state.preview.height - 2, 'timeline remains below preview');
    if (process.env.VCUT_TOOLBAR_SCREENSHOT) await page.screenshot({ path: process.env.VCUT_TOOLBAR_SCREENSHOT });
    const defaultCenterWidth = state.workspaceColumns[1];
    await page.locator('[aria-label="Media"]').first().click();
    state = await layout(page);
    assert.equal(state.mediaVisible, true, 'Media button opens the existing side panel');
    assert.ok(state.workspaceColumns[1] < defaultCenterWidth, 'canvas workspace refits when the panel opens');
    await page.locator('[aria-label="Media"]').first().click();
    assert.equal((await layout(page)).mediaVisible, false);

    // Changing the position must preserve the mounted editor and current selection/zoom.
    await page.locator('canvas').click({ position: { x: 20, y: 20 } });
    await page.getByRole('button', { name: 'Zoom preview in' }).click();
    const zoom = await page.getByRole('button', { name: 'Reset preview zoom' }).textContent();
    await page.getByRole('button', { name: 'Toolbar Position' }).click();
    await page.getByRole('group', { name: 'Toolbar Position' }).getByRole('button', { name: 'Bottom', exact: true }).click();
    state = await layout(page);
    assert.equal(state.direction, 'row');
    assert.equal(state.preference, 'bottom');
    assert.equal(state.mediaVisible, true, 'bottom layout restores its existing media panel');
    assert.equal(await page.getByRole('button', { name: 'Reset preview zoom' }).textContent(), zoom);
    assert.ok((await page.getByRole('button', { name: 'Crop & Rotate' }).count()) > 0, 'selection survives position switch');
    await page.reload({ waitUntil: 'networkidle' });
    state = await layout(page);
    assert.equal(state.direction, 'row', 'bottom preference survives refresh');
    assert.equal(state.rootPreference, 'bottom', 'saved preference is applied before hydration');
    assert.ok(state.rail.y >= state.workspace.y + state.workspace.height - 1, 'bottom toolbar remains below the workspace');
    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    let popupBox = await page.locator('[role="menu"]').last().boundingBox();
    assert.ok(popupBox.y + popupBox.height <= state.rail.y + 1, 'bottom picker still opens above its toolbar');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toolbar Position' }).click();
    await page.getByRole('group', { name: 'Toolbar Position' }).getByRole('button', { name: 'Left', exact: true }).click();
    assert.equal((await layout(page)).direction, 'column');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal((await layout(page)).direction, 'column', 'left preference survives refresh');
    await page.goto(`${base}/edit?projectId=${otherId}`, { waitUntil: 'networkidle' });
    assert.equal((await layout(page)).direction, 'column', 'preference survives changing projects');
    await page.goto(`${base}/edit?projectId=${id}`, { waitUntil: 'networkidle' });

    const textButton = page.getByRole('button', { name: 'Add text', exact: true }).first();
    await textButton.click();
    const popup = page.locator('[role="menu"]').last();
    await popup.waitFor();
    popupBox = await popup.boundingBox();
    assert.ok(popupBox.x >= 50, 'tool menu opens beside the vertical rail');
    assert.ok(popupBox.x + popupBox.width <= 1440, 'tool menu stays in viewport');

    await page.setViewportSize({ width: 390, height: 844 });
    state = await layout(page);
    assert.equal(state.direction, 'row', 'mobile always uses the bottom toolbar');
    assert.ok(state.rail.y >= state.workspace.y + state.workspace.height - 1);
    assert.equal(state.preference, 'left', 'mobile does not overwrite the desktop preference');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal((await layout(page)).direction, 'column');
    assert.deepEqual(errors, []);
    console.log('PASS toolbar: desktop default, panel, canvas, state, preference, reload, picker, mobile override');
  } finally {
    if (browser) await browser.close();
    const ended = new Promise(resolve => server.once('exit', resolve));
    server.kill(); if (server.exitCode === null) await ended;
    const resolved = path.resolve(tmp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('vcut-toolbar-check-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
