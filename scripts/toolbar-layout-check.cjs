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
    const properties = document.querySelector('.vcut-properties-panel');
    const preview = document.querySelector('canvas');
    const timeline = workspace.querySelector('[class*="row-start-2"]');
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      direction: getComputedStyle(rail).flexDirection,
      workspaceColumns: getComputedStyle(workspace).gridTemplateColumns.split(' ').map(Number.parseFloat),
      rail: rect(rail), workspace: rect(workspace), preview: rect(preview), timeline: rect(timeline), media: rect(media), properties: rect(properties),
      mediaVisible: getComputedStyle(media).display !== 'none',
      propertiesVisible: getComputedStyle(properties).display !== 'none',
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
  const otherProject = createProject(otherId, 'Other toolbar project');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLTTAAAAABJRU5ErkJggg==', 'base64');
  const imageAsset = { id: 'toolbar-image', kind: 'image', name: 'Test image', relPath: 'test.png', duration: 0, width: 1080, height: 1920, hasAudio: false, sizeBytes: imageBytes.length, importedAt: Date.now() };
  otherProject.assets = [imageAsset];
  otherProject.sequence.tracks[0].clips = [createClip({ assetId: imageAsset.id, sourceIn: 0, sourceOut: 3, timelineStart: 0 })];
  fs.mkdirSync(path.join(otherDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'media', imageAsset.relPath), imageBytes);
  fs.writeFileSync(path.join(otherDir, 'project.json'), JSON.stringify(otherProject));
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
    assert.equal(state.propertiesVisible, false, 'Properties auto-hides with no clip selected');
    assert.ok(state.preview.width > 0 && state.preview.height > 0);
    assert.ok(state.timeline.y >= state.preview.y + state.preview.height - 2, 'timeline remains below preview');
    await page.locator('canvas').click({ position: { x: 20, y: 20 } });
    state = await layout(page);
    assert.equal(state.propertiesVisible, true, 'selecting a clip opens Properties');
    assert.ok(state.properties.height >= state.workspace.height - 2, 'Properties defaults to full height');
    assert.ok(state.timeline.x + state.timeline.width <= state.properties.x + 1, 'timeline ends before full-height Properties');
    await page.getByRole('button', { name: 'Keep Properties above timeline' }).click();
    assert.ok((await layout(page)).properties.height < state.workspace.height - 100, 'Properties can remain above the timeline');
    await page.getByRole('button', { name: 'Extend Properties to bottom' }).click();
    await page.getByRole('button', { name: 'Back to all tools' }).click();
    state = await layout(page);
    assert.equal(state.workspaceColumns[2], 0, 'deselecting a clip releases Properties width');
    assert.equal(state.propertiesVisible, false, 'deselecting auto-hides Properties');
    await page.getByRole('button', { name: 'Expand Properties' }).click();
    assert.equal((await layout(page)).propertiesVisible, true);
    await page.getByRole('button', { name: 'Collapse Properties' }).click();
    await page.getByRole('button', { name: 'Collapse timeline' }).click();
    state = await layout(page);
    assert.ok(state.timeline.height <= 38, 'timeline collapses to a compact reopen strip');
    assert.ok(await page.getByRole('button', { name: 'Expand timeline' }).isVisible());
    await page.getByRole('button', { name: 'Expand timeline' }).click();
    assert.ok((await layout(page)).timeline.height > 100, 'timeline expands without remounting');
    if (process.env.VCUT_TOOLBAR_SCREENSHOT) await page.screenshot({ path: process.env.VCUT_TOOLBAR_SCREENSHOT });
    const defaultCenterWidth = state.workspaceColumns[1];
    await page.locator('[aria-label="Media"]').first().click();
    state = await layout(page);
    assert.equal(state.mediaVisible, true, 'Media button opens the existing side panel');
    assert.ok(state.mediaVisible && state.timeline.x >= state.media.x + state.media.width - 1, 'Media uses the full-height shared left panel');
    assert.ok(state.workspaceColumns[1] < defaultCenterWidth, 'canvas workspace refits when the panel opens');
    await page.getByRole('button', { name: 'Keep panel above timeline' }).click();
    state = await layout(page);
    assert.ok(state.timeline.x <= state.workspace.x + 1, 'left panel can stop above the timeline');
    await page.getByRole('button', { name: 'Extend panel to bottom' }).click();
    await page.getByRole('button', { name: 'Collapse tool panel' }).click();
    assert.equal((await layout(page)).workspaceColumns[0], 0, 'Media shares the panel collapse control');
    await page.getByRole('button', { name: 'Expand tool panel' }).click();
    assert.ok((await layout(page)).workspaceColumns[0] > 0, 'Media panel reopens');
    await page.locator('[aria-label="Media"]').first().click();
    assert.equal((await layout(page)).mediaVisible, false);

    const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts' });
    let shortcutBox = await shortcuts.boundingBox();
    assert.ok(shortcutBox.y + shortcutBox.height >= state.rail.y + state.rail.height - 12, 'Shortcuts stays at the foot of the left rail');
    await shortcuts.click();
    await page.locator('.vcut-docked-frame[aria-label="Keyboard shortcuts"]').waitFor();
    state = await layout(page);
    assert.equal(state.workspaceColumns[0], 340, 'Shortcuts opens in the left tool column');
    assert.ok(state.timeline.x >= state.workspace.x + 340 - 1, 'timeline begins beside the full-height tool panel');
    const shortcutsFrameBox = await page.locator('.vcut-docked-frame[aria-label="Keyboard shortcuts"]').boundingBox();
    assert.ok(shortcutsFrameBox.height >= state.workspace.height - 2, 'tool panel spans the preview and timeline rows');
    await page.getByRole('button', { name: 'Keep panel above timeline' }).click();
    assert.ok((await page.locator('.vcut-docked-frame[aria-label="Keyboard shortcuts"]').boundingBox()).height < state.workspace.height - 100, 'a docked tool can stop above the timeline');
    assert.ok((await layout(page)).timeline.x <= state.workspace.x + 1, 'timeline regains the left width below a shorter tool panel');
    await page.getByRole('button', { name: 'Extend panel to bottom' }).click();
    await page.getByRole('button', { name: 'Collapse tool panel' }).click();
    state = await layout(page);
    assert.equal(state.workspaceColumns[0], 0, 'chevron collapses the tool column');
    assert.ok(state.timeline.x <= state.workspace.x + 1, 'timeline regains the released space');
    await page.getByRole('button', { name: 'Expand tool panel' }).click();
    assert.equal((await layout(page)).workspaceColumns[0], 340, 'chevron reopens the same tool');
    await shortcuts.click();
    assert.equal((await layout(page)).mediaVisible, false);

    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    const addTextMenu = page.getByRole('menu', { name: 'Add text' });
    await addTextMenu.waitFor();
    assert.ok(await addTextMenu.getByRole('button', { name: 'Close' }).isVisible(), 'Add Text has a visible close control');
    const textGrid = addTextMenu.locator('.grid.grid-cols-3.overflow-y-auto');
    assert.ok((await textGrid.boundingBox()).height > 400, 'Add Text styles fill the dock height');
    await addTextMenu.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Add a color background' }).click();
    const backgroundMenu = page.getByRole('menu', { name: 'Background color' });
    assert.ok(await backgroundMenu.getByRole('button', { name: 'Close' }).isVisible(), 'Background has a title and close control');
    await backgroundMenu.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Import Text as Clips' }).click();
    const scriptFrame = page.locator('.vcut-docked-frame[aria-label="Import Text as Clips"]');
    await scriptFrame.waitFor();
    const scriptBox = await scriptFrame.boundingBox();
    assert.ok(scriptBox.height > 800, 'Script tool fills the left column height');
    assert.ok((await scriptFrame.locator('div.overflow-y-auto').last().boundingBox()).height > 100, 'Script font grid gets usable vertical space');
    if (process.env.VCUT_TOOLBAR_DOCK_SCREENSHOT) await page.screenshot({ path: process.env.VCUT_TOOLBAR_DOCK_SCREENSHOT });
    await page.getByRole('button', { name: 'Auto Captions' }).click();
    await page.locator('.vcut-docked-frame[aria-label="Auto Captions"]').waitFor();
    assert.equal(await scriptFrame.count(), 0, 'switching tools replaces the dock content');
    await page.getByRole('button', { name: 'Auto Captions' }).click();

    // Changing the position must preserve the mounted editor and current selection/zoom.
    await page.locator('canvas').click({ position: { x: 20, y: 20 } });
    await page.getByRole('button', { name: 'Zoom preview in' }).click();
    const zoom = await page.getByRole('button', { name: 'Reset preview zoom' }).textContent();
    await page.getByRole('button', { name: 'More options' }).click();
    assert.equal(await page.getByRole('menuitem', { name: 'Language' }).count(), 1, 'language is available in the header menu');
    await page.getByRole('button', { name: 'Toolbar Position' }).click();
    await page.getByRole('group', { name: 'Toolbar Position' }).getByRole('button', { name: 'Bottom', exact: true }).click();
    state = await layout(page);
    assert.equal(state.direction, 'row');
    assert.equal(state.preference, 'bottom');
    assert.equal(state.mediaVisible, true, 'bottom layout restores its existing media panel');
    shortcutBox = await shortcuts.boundingBox();
    assert.ok(shortcutBox.x + shortcutBox.width >= state.rail.x + state.rail.width - 12, 'Shortcuts stays at the right of the bottom toolbar');
    await shortcuts.click();
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
    assert.equal(await page.locator('.vcut-docked-frame').count(), 0, 'bottom Shortcuts uses the regular modal');
    await page.keyboard.press('Escape');
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
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('button', { name: 'Toolbar Position' }).click();
    await page.getByRole('group', { name: 'Toolbar Position' }).getByRole('button', { name: 'Left', exact: true }).click();
    assert.equal((await layout(page)).direction, 'column');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal((await layout(page)).direction, 'column', 'left preference survives refresh');
    await page.goto(`${base}/edit?projectId=${otherId}`, { waitUntil: 'networkidle' });
    assert.equal((await layout(page)).direction, 'column', 'preference survives changing projects');
    await page.locator('canvas').click({ position: { x: 20, y: 20 } });
    for (const [buttonName, menuName] of [
      ['Choose a transition', 'Transition style'],
      ['Filters', 'Filters'],
      ['Effects', 'Effects'],
      ['AI & Smart Tools (Remove Object, Cutout, Text Behind Subject, Generative Edit)', null],
    ]) {
      await page.locator('.vcut-toolbar').getByRole('button', { name: buttonName }).click();
      const picker = menuName ? page.getByRole('menu', { name: menuName }) : page.locator('.vcut-tool-panel-root > div');
      assert.ok(await picker.getByRole('button', { name: 'Close' }).isVisible(), `${buttonName} has a close control`);
      await picker.getByRole('button', { name: 'Close' }).click();
    }
    const flipButton = page.locator('button[title="Flip Horizontal"][aria-pressed]');
    await flipButton.waitFor();
    await flipButton.click();
    assert.equal(await flipButton.getAttribute('aria-pressed'), 'true', 'canvas Flip uses the selected clip state');
    await page.getByRole('button', { name: 'Clip options' }).click();
    await page.getByRole('menuitem', { name: 'Add Mask' }).click();
    await page.getByRole('button', { name: 'Clip options' }).click();
    assert.ok(await page.getByRole('menuitem', { name: 'Remove Mask' }).isVisible(), 'canvas menu reflects an applied mask');
    await page.keyboard.press('Escape');
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
    assert.equal(await page.getByRole('button', { name: 'Keyboard shortcuts' }).count(), 0, 'Shortcuts is hidden on mobile');
    await page.getByRole('button', { name: 'More options' }).click();
    const moreBox = await page.getByRole('menu', { name: 'Editor menu' }).boundingBox();
    assert.ok(moreBox.x >= 0 && moreBox.x + moreBox.width <= 390, 'header menu fits the mobile viewport');
    assert.equal(await page.getByRole('menuitem', { name: 'Language' }).count(), 1);
    await page.keyboard.press('Escape');
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
