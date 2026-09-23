const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");

const root = path.resolve(__dirname, "../../../..");
const frame = 1 / 30;
const closeToFrame = (actual, expected) => Math.abs(actual - expected) <= frame + 1e-7;

(async () => {
  const { createProject, createColorAsset, createClip } = await import(
    pathToFileURL(path.join(root, "packages/vcut/src/project/createProject.ts"))
  );
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vcut-timeline-check-"));
  const serverRoot = path.join(root, "apps/vcut-desktop/release/win-unpacked/resources/vcut");
  const port = 31991;
  const base = `http://127.0.0.1:${port}`;
  let serverLog = "";
  let browser;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: serverRoot,
    windowsHide: true,
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", VEASNA_WORKSPACE_ROOT: workspace },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        if ((await fetch(base)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, serverLog);
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });

    for (const width of [1440, 390]) {
      const projectId = `timeline-${width}`;
      const project = createProject(projectId, "Timeline precision check");
      project.assets = ["#315a91", "#9b4964", "#3f815e"].map(createColorAsset);
      project.sequence.tracks[0].clips = project.assets.map((asset, index) =>
        createClip({ assetId: asset.id, sourceIn: 0, sourceOut: 2, timelineStart: index * 4 })
      );
      const projectDirectory = path.join(workspace, ".vcut", projectId);
      fs.mkdirSync(projectDirectory, { recursive: true });
      const projectFile = path.join(projectDirectory, "project.json");
      fs.writeFileSync(projectFile, JSON.stringify(project));

      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/edit?projectId=${projectId}`);
      const ruler = page.getByRole("slider", { name: "Playhead" });
      await ruler.waitFor();
      const clips = page.locator("[data-clip-id]");
      assert.equal(await clips.count(), 3);

      const save = async () => {
        await page.evaluate(() => document.activeElement?.blur());
        await page.keyboard.press("Control+s");
        await page.getByText("All changes saved", { exact: true }).waitFor();
        return JSON.parse(fs.readFileSync(projectFile, "utf8"));
      };

      const rulerBox = await ruler.boundingBox();
      assert.ok(rulerBox);
      if (width >= 1000) {
        const anchorX = rulerBox.x + Math.min(360, rulerBox.width * 0.55);
        await page.mouse.click(anchorX, rulerBox.y + rulerBox.height / 2);
        const beforeZoom = Number(await ruler.getAttribute("aria-valuenow"));
        await page.keyboard.down("Control");
        await page.mouse.move(anchorX, rulerBox.y + rulerBox.height / 2);
        await page.mouse.wheel(0, -120);
        await page.keyboard.up("Control");
        await page.waitForTimeout(100);
        await page.mouse.click(anchorX, rulerBox.y + rulerBox.height / 2);
        const afterZoom = Number(await ruler.getAttribute("aria-valuenow"));
        assert.ok(closeToFrame(afterZoom, beforeZoom), `zoom anchor drifted: ${beforeZoom} -> ${afterZoom}`);

        await page.getByRole("button", { name: "Reset zoom" }).click();
        await ruler.press("Home");
        await page.waitForTimeout(100);

        const second = clips.nth(1);
        const secondBox = await second.boundingBox();
        assert.ok(secondBox);
        await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(secondBox.x + secondBox.width / 2 - 115, secondBox.y + secondBox.height / 2, { steps: 6 });
        await page.locator("[data-timeline-snap-guide]").waitFor();
        await page.mouse.up();
        let saved = await save();
        assert.equal(saved.sequence.tracks[0].clips.find((item) => item.id === project.sequence.tracks[0].clips[1].id).timelineStart, 2);

        await page.keyboard.press("Control+z");
        saved = await save();
        assert.equal(saved.sequence.tracks[0].clips.find((item) => item.id === project.sequence.tracks[0].clips[1].id).timelineStart, 4);

        const first = clips.nth(0);
        await first.click();
        const trimEnd = first.getByRole("separator", { name: "Trim clip end" });
        const trimBox = await trimEnd.boundingBox();
        const restoredSecondBox = await second.boundingBox();
        assert.ok(trimBox && restoredSecondBox);
        await page.mouse.move(trimBox.x + trimBox.width / 2, trimBox.y + trimBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(restoredSecondBox.x - 5, trimBox.y + trimBox.height / 2, { steps: 6 });
        await page.locator("[data-timeline-snap-guide]").waitFor();
        await page.mouse.up();
        saved = await save();
        const savedFirst = saved.sequence.tracks[0].clips.find((item) => item.id === project.sequence.tracks[0].clips[0].id);
        assert.equal(savedFirst.sourceOut - savedFirst.sourceIn, 4);

        const junction = page.locator("[data-transition-junction]").first();
        await junction.waitFor();
        const junctionBox = await junction.boundingBox();
        const adjacentBox = await second.boundingBox();
        assert.ok(junctionBox && adjacentBox);
        assert.ok(Math.abs(junctionBox.x + junctionBox.width / 2 - adjacentBox.x) < 1.1, "junction is not centered on the cut");
      } else {
        const scroller = page.locator("#vcut-timeline-lanes");
        const beforeWidth = await scroller.evaluate((element) => element.scrollWidth);
        await scroller.evaluate((element) => {
          element.scrollLeft = 120;
          element.dispatchEvent(new Event("scroll"));
        });
        await page.waitForTimeout(100);
        assert.ok(closeToFrame(Number(await ruler.getAttribute("aria-valuenow")), 2));
        const centerX = rulerBox.x + rulerBox.width / 2;
        const centeredTime = Number(await ruler.getAttribute("aria-valuenow"));
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("vcut:zoom", { detail: { factor: 1.4 } })));
        await page.waitForTimeout(100);
        const afterWidth = await scroller.evaluate((element) => element.scrollWidth);
        assert.ok(afterWidth > beforeWidth, "mobile timeline did not zoom");
        await page.mouse.click(centerX, rulerBox.y + rulerBox.height / 2);
        assert.ok(closeToFrame(Number(await ruler.getAttribute("aria-valuenow")), centeredTime));
      }

      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: frame seeking, anchored zoom, scrolling${width >= 1000 ? ", snap guide, move, trim, undo, cut-centered transition" : " and fixed-center playhead"}`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    const ended = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    if (server.exitCode === null) await ended;
    const resolved = path.resolve(workspace);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("vcut-timeline-check-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
