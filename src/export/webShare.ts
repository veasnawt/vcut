/** Saving an export to the phone's photo library from a browser.
 *
 *  A web page cannot write to the Photos library silently — that is a deliberate browser/OS restriction, not
 *  something this app can work around. What Safari (iOS) and Chrome (Android) DO offer is the Web Share API with
 *  files: from a tap, it opens the system share sheet, which includes "Save Video" (into Photos/Gallery). That is
 *  one tap after the export finishes, and is the closest a web app gets to "save to gallery". The phone APP
 *  saves automatically (`nativeSaveExportToGallery`); this is the browser equivalent. */

/** Whether this browser can share a video file through the system share sheet. */
export function canShareVideoFile(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([""], "probe.mp4", { type: "video/mp4" })] });
  } catch {
    return false;
  }
}

/** Fetches `url` and hands it to the share sheet as `fileName`. Must be called directly from a user gesture (the
 *  share sheet requires one). Resolves `true` when the sheet was shown and completed, `false` if the user
 *  dismissed it (not an error); throws for a real failure such as a failed download. */
export async function shareVideoFile(url: string, fileName: string): Promise<boolean> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read the exported video (HTTP ${response.status})`);
  const file = new File([await response.blob()], fileName, { type: "video/mp4" });
  try {
    await navigator.share({ files: [file], title: fileName });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return false; // the user closed the sheet
    throw err;
  }
}
