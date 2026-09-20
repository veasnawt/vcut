import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const ROOT = "D:/Veasna/App Development/veasna-os/packages/vcut";
const { buildExportPlan } = await import(`file:///${ROOT}/src/export/buildExportPlan.ts`);
const { addClip, setClipTransitionIn, setClipTransitionOut } = await import(`file:///${ROOT}/src/timeline/operations.ts`);
const { clipsOf, emptyProject, videoAsset, videoTrackId } = await import(`file:///${ROOT}/tests/fixture.ts`);
const { clipEnd } = await import(`file:///${ROOT}/src/project/createProject.ts`);

const FF = "D:/Veasna/App Development/veasna-os/node_modules/.pnpm/ffmpeg-static@5.3.0_supports-color@8.1.1/node_modules/ffmpeg-static/ffmpeg.exe";
const OUT = path.resolve(process.argv[2] ?? ".");
const W = Number(process.env.W ?? 360);
const H = Number(process.env.H ?? 640);
const types = (process.argv[3] ?? "crossfade,wipeLeft,slideLeft,sliceUp,sliceDown,circleOpen,circleClose,glitchCut,waterRippleCut,zoomBlur,whipPanLeft,flashZoom").split(",");
const solo = process.env.SOLO !== "0";

function media(name: string, src: string) {
  const file = path.join(OUT, `${name}.mp4`);
  if (!fs.existsSync(file)) {
    execFileSync(FF, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `${src}=s=${W}x${H}:d=3:r=30`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  }
  return file;
}
const files: Record<string, string> = { a: media("A", "testsrc2"), b: media("B", "smptehdbars") };

for (const type of types) {
  const asset = (id: string) => ({ ...videoAsset(id, 3), width: W, height: H });
  let project = emptyProject([asset("a"), asset("b")]);
  project.sequence.width = W;
  project.sequence.height = H;
  project.exportSettings = { ...project.exportSettings, width: W, height: H, fps: 30 };
  const track = videoTrackId(project);
  project = addClip(project, track, "a", 0);
  const [clipA] = clipsOf(project, track);
  project = addClip(project, track, "b", clipEnd(clipA));
  const [, clipB] = clipsOf(project, track);
  project = setClipTransitionIn(project, clipB.id, { duration: 1, type });
  if (solo) {
    project = setClipTransitionIn(project, clipA.id, { duration: 1, type });
    project = setClipTransitionOut(project, clipB.id, { duration: 1, type });
  }
  const outputPath = path.join(OUT, `out_${type}.mp4`);
  const { args } = buildExportPlan(project, {
    inputPathFor: (id: string) => files[id],
    outputPath,
    fontPathFor: (f: string) => f,
    textFilePathFor: (c: { id: string }) => path.join(OUT, `${c.id}.txt`),
  });
  fs.writeFileSync(path.join(OUT, `graph_${type}.txt`), args[args.indexOf("-filter_complex") + 1]);
  const t0 = Date.now();
  try {
    execFileSync(FF, args, { stdio: "pipe" });
  } catch (e: any) {
    console.log(`FAIL ${type}: ${String(e.stderr).split("\n").slice(-6).join(" | ")}`);
    continue;
  }
  const ms = Date.now() - t0;
  // Timeline: A 0-3 (solo fade-in 0-1), blend 2-3, B 3-6 (solo fade-out 5-6) — frames every 1/6s
  // across each window, three rows.
  const rows = solo ? [[0, 1], [3, 4], [5, 6]] : [[3, 4]];
  const sel = rows.flatMap(([a, b]) => Array.from({ length: 6 }, (_, i) => Math.round((a + (i + 0.5) * ((b - a) / 6)) * 30)));
  const expr = sel.map((f) => `eq(n\\,${f})`).join("+");
  execFileSync(FF, ["-y", "-loglevel", "error", "-i", outputPath, "-vf", `select='${expr}',scale=120:-1,tile=6x${rows.length}`, "-frames:v", "1", path.join(OUT, `tile_${type}.png`)]);
  console.log(`ok ${type} (${ms}ms)`);
}
