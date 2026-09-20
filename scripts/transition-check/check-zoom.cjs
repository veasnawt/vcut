// Compare the production Canvas compositor with the real export graph on a centered pattern.
// Optional local tool paths: PLAYWRIGHT_MODULE, ESBUILD_MODULE, CHROMIUM_PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const esbuild = require(process.env.ESBUILD_MODULE || 'esbuild');
const root = path.resolve(__dirname, '../..');
(async () => {
  const { buildExportPlan } = await import(pathToFileURL(path.join(root, 'src/export/buildExportPlan.ts')));
  const { emptyProject, imageAsset, videoTrackId } = await import(pathToFileURL(path.join(root, 'tests/fixture.ts')));
  const { addClip } = await import(pathToFileURL(path.join(root, 'src/timeline/operations.ts')));
  const ffmpeg = createRequire(path.join(root, '../../studios/vcut/package.json'))('ffmpeg-static');
  const bundle = await esbuild.build({stdin: {contents: `import { compositeTransitionFrame } from './src/playback/PlaybackEngine.ts'; window.renderTransition = compositeTransitionFrame;`, resolveDir: root, loader: 'ts'}, bundle: true, format: 'iife', platform: 'browser', write: false});
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vcut-zoom-check-'));
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH});
  try {
    const W = 320, H = 180, frames = [0, 3, 8, 15, 22, 27, 29];
    const pixels = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const value = x >= W / 4 && x < W * 3 / 4 ? 255 : 0;
      pixels.fill(value, (y * W + x) * 3, (y * W + x) * 3 + 3);
    }
    const source = path.join(scratch, 'pattern.ppm');
    fs.writeFileSync(source, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), pixels]));
    const page = await browser.newPage();
    await page.addScriptTag({content: bundle.outputFiles[0].text});
    for (const type of ['zoomBlur', 'flashZoom']) {
      let project = emptyProject([{...imageAsset('a'), width: W, height: H}, {...imageAsset('b'), width: W, height: H}]);
      project.sequence.width = W; project.sequence.height = H;
      project.exportSettings = {...project.exportSettings, width: W, height: H, fps: 30};
      project = addClip(project, videoTrackId(project), 'a', 0);
      const a = project.sequence.tracks.find(t => t.kind === 'video').clips[0]; a.sourceOut = 1;
      project = addClip(project, videoTrackId(project), 'b', 1);
      const b = project.sequence.tracks.find(t => t.kind === 'video').clips[1]; b.sourceOut = 2; b.transitionIn = {type, duration: 1};
      const {args} = buildExportPlan(project, {inputPathFor: () => source, outputPath: 'pipe:1', fontPathFor: f => f, textFilePathFor: c => c.id});
      const i = args.indexOf('-filter_complex');
      const graphFile = path.join(scratch, 'graph.txt'); fs.writeFileSync(graphFile, args[i + 1] + ';' + args[i + 5] + 'anullsink');
      const raw = execFileSync(ffmpeg, ['-v', 'error', ...args.slice(0, i), '-filter_complex_script', graphFile, '-map', args[i + 3], '-t', '3', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], {maxBuffer: 80 * 1024 * 1024, timeout: 30000});
      const preview = await page.evaluate(({W,H,frames,type}) => {
        const source = document.createElement('canvas'); source.width=W; source.height=H;
        const s = source.getContext('2d'); s.fillStyle='black'; s.fillRect(0,0,W,H); s.fillStyle='white'; s.fillRect(W/4,0,W/2,H);
        const target = document.createElement('canvas'); target.width=W; target.height=H;
        const ctx = target.getContext('2d', {willReadFrequently:true});
        return frames.map(frame => {
          ctx.fillStyle='black';ctx.fillRect(0,0,W,H);
          window.renderTransition(ctx,W,H,type,frame/30,source,source,1);
          const row=ctx.getImageData(0,H/2,W,1).data;
          return Array.from({length:W},(_,x)=>row[x*4]);
        });
      }, {W,H,frames,type});
      console.log(type);
      frames.forEach((frame, j) => {
        const row = Array.from({length:W},(_,x)=>raw[((30+frame)*W*H+H/2*W+x)*3]);
        const expected=preview[j];
        const diffs=row.map((v,x)=>Math.abs(v-expected[x]));
        const mae = diffs.reduce((a,b)=>a+b,0)/W;
        console.log(JSON.stringify({frame,mae: +mae.toFixed(2),max:Math.max(...diffs)}));
        // Allow Canvas/FFmpeg blur-kernel and integer scaling differences. Before the crop fix,
        // Zoom Blur's midpoint differed by 57 levels on average; after it the maximum is below 5.
        assert.ok(mae < 8, `${type} frame ${frame}: preview/export mean error ${mae}`);
      });
    }
  } finally {
    await browser.close();
    const target=path.resolve(scratch);
    if(!target.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(target).startsWith('vcut-zoom-check-')) throw new Error('Unsafe scratch path');
    fs.rmSync(target,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
