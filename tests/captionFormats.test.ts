import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractCaptionCues, parseCaptionFile, parseSrt, parseVtt, serializeSrt, serializeVtt } from "../src/captions/captionFormats.ts";
import { createProject, createTextAsset } from "../src/project/createProject.ts";
import { addTrack } from "../src/timeline/operations.ts";
import type { Project } from "../src/project/types.ts";
import { DEFAULT_TEXT_STYLE } from "../src/project/types.ts";

const CUES = [
  { start: 1, end: 4, text: "Hello world" },
  { start: 5.5, end: 7.25, text: "Second line" },
  { start: 10, end: 12.999, text: "Multi-line\ncaption text" },
];

describe("serializeSrt", () => {
  it("formats timestamps as HH:MM:SS,mmm with a comma decimal separator", () => {
    const srt = serializeSrt([{ start: 61.5, end: 63.005, text: "hi" }]);
    assert.equal(srt, "1\n00:01:01,500 --> 00:01:03,005\nhi\n");
  });

  it("numbers cues sequentially starting at 1 and separates them with a blank line", () => {
    const srt = serializeSrt(CUES);
    assert.match(srt, /^1\n/);
    assert.ok(srt.includes("\n\n2\n"));
    assert.ok(srt.includes("\n\n3\n"));
  });

  it("never rounds a millisecond remainder up to an invalid 1000", () => {
    // 4.9996s rounds to 5000ms total — flooring hours/minutes/seconds first and taking the remainder
    // as milliseconds would produce "00:00:04,1000" (invalid) instead of correctly carrying to
    // "00:00:05,000".
    const srt = serializeSrt([{ start: 0, end: 4.9996, text: "x" }]);
    assert.ok(srt.includes("00:00:05,000"), srt);
  });
});

describe("serializeVtt", () => {
  it("starts with a WEBVTT header and uses a dot decimal separator", () => {
    const vtt = serializeVtt([{ start: 61.5, end: 63.005, text: "hi" }]);
    assert.ok(vtt.startsWith("WEBVTT\n\n"));
    assert.ok(vtt.includes("00:01:01.500 --> 00:01:03.005"));
    assert.ok(!vtt.includes(","), "VTT must never use a comma decimal separator");
  });
});

describe("parseSrt / parseVtt round-trip", () => {
  it("round-trips SRT: parse(serialize(cues)) equals the original cues", () => {
    const parsed = parseSrt(serializeSrt(CUES));
    assert.deepEqual(parsed, CUES);
  });

  it("round-trips VTT: parse(serialize(cues)) equals the original cues", () => {
    const parsed = parseVtt(serializeVtt(CUES));
    assert.deepEqual(parsed, CUES);
  });

  it("ignores VTT cue settings after the timestamp (align:, position:, ...)", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start position:10%\nHello\n";
    const parsed = parseVtt(vtt);
    assert.deepEqual(parsed, [{ start: 1, end: 2, text: "Hello" }]);
  });

  it("ignores a VTT cue identifier line before the timing line", () => {
    const vtt = "WEBVTT\n\ncue-1\n00:00:01.000 --> 00:00:02.000\nHello\n";
    const parsed = parseVtt(vtt);
    assert.deepEqual(parsed, [{ start: 1, end: 2, text: "Hello" }]);
  });

  it("skips a NOTE/STYLE block with no timing line instead of erroring", () => {
    const vtt = "WEBVTT\n\nNOTE this is a comment\n\n00:00:01.000 --> 00:00:02.000\nHello\n";
    const parsed = parseVtt(vtt);
    assert.deepEqual(parsed, [{ start: 1, end: 2, text: "Hello" }]);
  });

  it("preserves multi-line cue text", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two\n";
    const parsed = parseSrt(srt);
    assert.equal(parsed[0].text, "Line one\nLine two");
  });

  it("accepts the shorter MM:SS.mmm form with no hours component", () => {
    const vtt = "WEBVTT\n\n01:02.500 --> 01:05.000\nHello\n";
    const parsed = parseVtt(vtt);
    assert.deepEqual(parsed, [{ start: 62.5, end: 65, text: "Hello" }]);
  });

  it("drops a cue with an inverted or zero-duration timing range rather than emitting it", () => {
    const srt = "1\n00:00:05,000 --> 00:00:02,000\nBad cue\n\n2\n00:00:10,000 --> 00:00:12,000\nGood cue\n";
    const parsed = parseSrt(srt);
    assert.deepEqual(parsed, [{ start: 10, end: 12, text: "Good cue" }]);
  });

  it("handles CRLF line endings the same as LF", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n";
    assert.deepEqual(parseSrt(srt), [{ start: 1, end: 2, text: "Hello" }]);
  });
});

describe("parseCaptionFile (format sniffing)", () => {
  it("detects a WEBVTT header and parses with the dot decimal separator", () => {
    const parsed = parseCaptionFile(serializeVtt(CUES));
    assert.deepEqual(parsed, CUES);
  });

  it("falls back to SRT parsing (identical logic) when there's no WEBVTT header", () => {
    const parsed = parseCaptionFile(serializeSrt(CUES));
    assert.deepEqual(parsed, CUES);
  });

  it("strips a leading UTF-8 BOM before checking for the WEBVTT header", () => {
    const parsed = parseCaptionFile("﻿" + serializeVtt(CUES));
    assert.deepEqual(parsed, CUES);
  });
});

describe("extractCaptionCues", () => {
  function projectWithTextTrack(): Project {
    let project = createProject("bp1");
    const withTrack = addTrack(project, "text", "t1");
    const asset1 = createTextAsset("Hello", DEFAULT_TEXT_STYLE);
    const asset2 = createTextAsset("World", DEFAULT_TEXT_STYLE);
    project = {
      ...withTrack,
      assets: [...withTrack.assets, asset1, asset2],
      sequence: {
        ...withTrack.sequence,
        tracks: withTrack.sequence.tracks.map((t) =>
          t.id === "t1"
            ? {
                ...t,
                clips: [
                  { id: "c1", assetId: asset1.id, sourceIn: 0, sourceOut: 2, timelineStart: 0 },
                  { id: "c2", assetId: asset2.id, sourceIn: 0, sourceOut: 1.5, timelineStart: 3 },
                ],
              }
            : t
        ),
      },
    };
    return project;
  }

  it("converts each text clip to a cue with absolute timeline start/end", () => {
    const cues = extractCaptionCues(projectWithTextTrack());
    assert.deepEqual(cues, [
      { start: 0, end: 2, text: "Hello" },
      { start: 3, end: 4.5, text: "World" },
    ]);
  });

  it("drops a clip whose asset has no text content", () => {
    let project = projectWithTextTrack();
    project = { ...project, assets: project.assets.map((a) => (a.textContent === "World" ? { ...a, textContent: "" } : a)) };
    const cues = extractCaptionCues(project);
    assert.deepEqual(cues, [{ start: 0, end: 2, text: "Hello" }]);
  });

  it("returns an empty array for a project with no text tracks", () => {
    assert.deepEqual(extractCaptionCues(createProject("bp1")), []);
  });
});
