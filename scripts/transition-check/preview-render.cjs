const { chromium } = require("C:/Users/Vergenzee/AppData/Local/npm-cache/_npx/ac56acf9ae97d38a/node_modules/playwright-core");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const SP = __dirname;
const FF = "D:/Veasna/App Development/veasna-os/node_modules/.pnpm/ffmpeg-static@5.3.0_supports-color@8.1.1/node_modules/ffmpeg-static/ffmpeg.exe";
const types = (process.argv[2] || "sliceUp,circleOpen,circleClose,zoomBlur,glitchCut,waterRippleCut,whipPanLeft,flashZoom,wipeLeft,slideLeft").split(",");
execFileSync(FF, ["-y", "-loglevel", "error", "-ss", "2.95", "-i", path.join(SP, "r/A.mp4"), "-frames:v", "1", path.join(SP, "a.png")]);
execFileSync(FF, ["-y", "-loglevel", "error", "-ss", "0.5", "-i", path.join(SP, "r/B.mp4"), "-frames:v", "1", path.join(SP, "b.png")]);
const dataUrl = (f) => "data:image/png;base64," + fs.readFileSync(f).toString("base64");
(async () => {
  const browser = await chromium.launch({ executablePath: "D:/pw-browsers/chromium-1234/chrome-win64/chrome.exe" });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  await page.addScriptTag({ content: fs.readFileSync(path.join(SP, "preview.js"), "utf8") });
  const png = await page.evaluate(
    async ({ a, b, types }) => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const W = 360, H = 640, TW = 120, TH = 213;
      const out = document.createElement("canvas");
      out.width = TW * 6; out.height = TH * types.length;
      const octx = out.getContext("2d");
      const frame = document.createElement("canvas");
      frame.width = W; frame.height = H;
      const fctx = frame.getContext("2d");
      const times = [];
      types.forEach((type, row) => {
        for (let i = 0; i < 6; i++) {
          fctx.fillStyle = "#000"; fctx.fillRect(0, 0, W, H);
          const t0 = performance.now();
          window.compositeTransitionFrame(fctx, W, H, type, (i + 0.5) / 6, ia, ib, 1);
          times.push([type, performance.now() - t0]);
          octx.drawImage(frame, i * TW, row * TH, TW, TH);
        }
      });
      return { url: out.toDataURL("image/png"), times };
    },
    { a: dataUrl(path.join(SP, "a.png")), b: dataUrl(path.join(SP, "b.png")), types }
  );
  fs.writeFileSync(path.join(SP, "preview_tiles.png"), Buffer.from(png.url.split(",")[1], "base64"));
  const agg = {};
  for (const [t, ms] of png.times) agg[t] = Math.max(agg[t] || 0, ms);
  console.log(JSON.stringify(agg));
  await browser.close();
})();
