import { Capacitor } from "@capacitor/core";
import { getAccessToken, getCachedAccessToken } from "@veasnawt/auth";
import { deserializeProject } from "../project/serialize.ts";
import type { TemplateProjectData } from "../project/template.ts";
import type { StickerProvider, StickerType } from "../project/stickers.ts";
import type { MusicCategory, MusicTrack } from "../project/music.ts";
import type { Asset, CustomFontAsset, CustomSfxAsset, LutAsset, Project } from "../project/types.ts";
import { nativeCancelExport, nativeExportAvailable, nativeStartExport, nativeWatchExport } from "./nativeExport.ts";
import {
  nativeCreateProjectFromTemplate,
  nativeDeleteMedia,
  nativeImportMedia,
  nativeLoadProject,
  nativeLoadTemplateForDraft,
  nativeMediaUrl,
  nativeSaveProject,
} from "./nativeStorage.ts";
import { nativeExtractCaptionAudio } from "./nativeCaptions.ts";

/** Browser-side client for VCut's server routes.
 *
 *  All paths are relative, so this works unchanged whether the app is served from `next dev` on
 *  :3001 or from the packaged desktop app's own loopback port. On the native (Capacitor) shell —
 *  where there is no server at all — each function below branches on `Capacitor.isNativePlatform()`
 *  and delegates to `nativeStorage.ts` instead, which is the ONE thing this session's mobile-app plan
 *  documents as needing per-function runtime branches rather than two parallel files (Capacitor
 *  bundles a single JS build that must also run in a plain dev browser). */
const BASE = "/api/vcut";
const isNative = Capacitor.isNativePlatform();

/** Set only in the hosted web build (Railway) — desktop's bundled build and local dev never set this.
 *  Narrowly means "is THIS build the literal vcut.io deployment" — still what `apiFetch` below needs
 *  to decide whether ITS OWN same-origin relative calls should attach a bearer token (desktop's local
 *  server never requires session auth for those). Do NOT use this to decide whether billing/credits/
 *  PRO-badge/self-key-entry UI should apply — see `CREDITS_ENABLED` below for that. */
export const HOSTED = process.env.NEXT_PUBLIC_VCUT_HOSTED === "true";

/** Whether billing/credits/PRO-badge concepts apply on THIS platform — always true. Every platform
 *  (hosted web, desktop, mobile) authenticates against the one live vcut.io billing system instead of
 *  each needing its own local Stripe integration or a self-supplied API key (see `billing.ts`'s own
 *  doc comment on `BILLING_ORIGIN`) — Remove Object's and Auto Captions' desktop-only "paste your own
 *  Replicate key" UI was retired for the same reason: one centrally-funded credits system everywhere,
 *  not per-install local keys. Kept as a named export (not inlined `true`) so every place reading this
 *  decision stays easy to find and easy to revisit later, and to keep it clearly distinct from `HOSTED`
 *  above, which means something narrower. */
export const CREDITS_ENABLED = true;

/** Drop-in replacement for the global `fetch` every function below already called directly — in the
 *  hosted build, attaches the current Supabase session's access token as a bearer `Authorization`
 *  header; everywhere else (desktop, local dev, and any moment nobody's signed in even in a hosted
 *  build) it's exactly a plain `fetch` call, byte-for-byte the same request this file always sent.
 *  Centralizing this here — one wrapper every call site routes through — is what let the hosted
 *  server's routes gain real per-user auth (see `studios/vcut/app/api/vcut/_lib/localOnly.ts`'s
 *  `VCUT_HOSTED` branch) without touching the ~25 individual call sites below beyond their own name. */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!HOSTED) return fetch(input, init);
  const token = await getAccessToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (response.status !== 401) return response;
  // A 401 here isn't necessarily a genuinely dead session — a real, reported bug: it can also be a
  // stale-but-still-refreshable token, e.g. right after this same tab sat backgrounded for a while
  // (Supabase's own auto-refresh ticker pauses while hidden — see `getSupabaseBrowserClient`'s own
  // `visibilitychange` handler) and this very call raced that recovery. `getAccessToken()` re-checks
  // real expiry and refreshes through Supabase's own logic if the refresh token is still valid — one
  // retry with whatever that returns costs nothing when the session really IS dead (same token comes
  // back, or none at all, and the original 401 is returned unchanged), but silently recovers the far
  // more common case where it wasn't, instead of surfacing "session expired" to someone who was still
  // actively using the app moments earlier.
  const freshToken = await getAccessToken();
  if (!freshToken || freshToken === token) return response;
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set("Authorization", `Bearer ${freshToken}`);
  return fetch(input, { ...init, headers: retryHeaders });
}

/** Appends the current session token as a `?token=` query param, for the one class of caller that
 *  can't use `apiFetch`'s `Authorization` header: `EventSource`, which — like a plain `<video src>`
 *  (see `mediaUrl`'s own doc comment for the identical reasoning) — is a native browser API with no
 *  way to attach a custom header. `_lib/auth.ts`'s `requireSessionUser` accepts this same fallback.
 *  Confirmed as a real production gap, not theoretical: every export's progress connection failed
 *  immediately with "Lost contact with the export" on the real vcut.io deploy before this existed —
 *  `EventSource` got a bare 401, which browsers report as `readyState: CLOSED` (a permanent failure,
 *  not the auto-retrying `CONNECTING` state a genuine network blip produces), so `watchExport`'s own
 *  already-careful CLOSED-vs-CONNECTING handling correctly reported it as fatal — the connection
 *  really had failed, just not for the reason that logic exists to filter out. */
function sseUrl(path: string): string {
  if (!HOSTED) return path;
  const token = getCachedAccessToken();
  return token ? `${path}&token=${encodeURIComponent(token)}` : path;
}

/** For the handful of routes whose secret provider key (Pexels/KLIPY/GIPHY/Replicate) now only ever
 *  lives on the live vcut.io deployment — desktop's bundled server and mobile's Capacitor shell don't
 *  get their own local-key config UI (retired; see `useHostedCreditsGate.ts`'s own doc comment), so
 *  their SEARCH calls for Stock/Stickers/AI route straight there instead, same "absolute URL, bearer
 *  token, no cookie" shape `billing.ts`'s own `billingFetch` already uses. `!HOSTED` covers desktop,
 *  mobile, AND a plain local-dev browser tab alike — there's no separate "local" version of these
 *  routes to fall back to anymore, only the live one. When THIS build IS the hosted deployment, the
 *  absolute URL is same-origin and behaves identically to a relative one (billing.ts's own doc comment
 *  makes the identical point) — no behavior change there. Only for SEARCH/read endpoints: importing a
 *  picked result stays local (see `importStockResult`'s own doc comment for why). */
async function centralFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const url = HOSTED ? `${BASE}${path}` : `https://vcut.io${BASE}${path}`;
  return fetch(url, { ...init, headers });
}

/** `centralFetch`'s `EventSource` counterpart — same routing decision, but `EventSource` can't attach
 *  a custom `Authorization` header, so the session token rides as a `?token=` query param instead (the
 *  same fallback `sseUrl` already uses for the plain-hosted case; `requireSessionUser` accepts either).
 *  Deliberately NOT the same function as `sseUrl` above, even though the two look similar — `sseUrl` is
 *  shared by Export/Remove-Object's own SSE watches, which must always stay same-origin/local (they
 *  touch real local files and FFmpeg processes, nothing a remote server could do on the caller's own
 *  machine); only AI Video/Captions actually need the cross-origin routing this adds. */
function centralSseUrl(path: string): string {
  const token = getCachedAccessToken();
  const withToken = token ? `${path}&token=${encodeURIComponent(token)}` : path;
  return HOSTED ? withToken : `https://vcut.io${withToken}`;
}

export class ApiRequestError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Set once, by `editorStore.ts` at module init, to `() => set({ sessionExpired: true })` — this file
 *  can't import the store directly (the store already imports THIS file as `api.*`, so the reverse
 *  import would be circular), so a plain settable callback is the shared seam instead. Exists because
 *  `unwrap`'s own 401 used to just become whatever error text the ~25 individual call sites below
 *  happened to show it as ("Sign in required" verbatim, in Stock's case) — a real, reported bug: only
 *  `editorStore.save()`'s own catch block knew to treat a 401 as "the session died, offer sign-in"
 *  rather than an ordinary failure, so a stale token surfacing through any OTHER call (a stock search,
 *  an AI generation, an import) left the user stuck reading a raw, non-actionable error with no
 *  recovery path, even while the header's own sign-in-recovery banner existed right there for exactly
 *  this. Centralizing the DETECTION here means every one of those call sites gets the same recovery
 *  banner for free, with no need to teach each one individually what a 401 means. */
let sessionExpiredHandler: (() => void) | null = null;
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

export async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  // Routes report failures as JSON `{ error, code }`; anything else (a crash, a proxy error page)
  // still has to produce a usable message rather than "unexpected token < in JSON".
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    code = body?.code;
  } catch {
    /* keep the status-based message */
  }
  // `getCachedAccessToken()`, not just "was this a 401" — a 401 on a background call (a billing-status
  // check, a font-availability probe) is the ORDINARY, expected response for someone who's simply never
  // signed in at all, not a session that died. Firing the same "Session expired — Sign in" banner
  // (`SaveStatus`'s own header button) for that case was a real, reported bug: it told a visitor who'd
  // never touched sign-in that THEIR session had expired, which reads as confusing/alarming ("expired"
  // implies one existed) rather than the accurate, much calmer "sign in to do this." Only a 401 that
  // followed a REAL cached token (i.e., a session genuinely existed a moment ago and got rejected) is a
  // true expiry. `getCachedAccessToken` is a synchronous best-effort read (see its own doc comment) —
  // close enough to "was a token attached to THIS request" without threading that fact through every one
  // of `unwrap`'s ~25 call sites individually.
  if (response.status === 401 && getCachedAccessToken()) sessionExpiredHandler?.();
  throw new ApiRequestError(message, response.status, code);
}

/** Uploads `form` to `url` via `XMLHttpRequest` instead of `fetch`, reporting real upload progress
 *  through `onProgress` — the Fetch API has no request-body progress event at all (only a response-body
 *  `ReadableStream`, no use for an UPLOAD), so `apiFetch`'s plain `fetch()` is a dead end for this; XHR's
 *  `upload.onprogress` is the only standard browser API that exposes it. Used by `importMedia` below so
 *  a large video's own upload shows a real percentage instead of the import UI just sitting on
 *  "Importing…" for as long as a slow connection's own transfer takes — asked for directly, the same
 *  spirit `runFfmpeg`'s server-side progress callback already serves for export/captions/inpaint, just
 *  for the OTHER slow, silent phase of an import (the client→server transfer, not the server-side
 *  processing after it arrives). `onProgress` receives a 0–1 fraction, called only when the browser
 *  reports `lengthComputable` (always true for a `FormData` body carrying one `File`, which has a known
 *  byte length up front — never true for a chunked/streaming body, not a shape this ever sends).
 *
 *  Deliberately NOT a full `apiFetch` replacement: skips that function's own 401-then-refresh-and-retry
 *  dance (see its own doc comment) for a single XHR request — a real but rare edge case (a token going
 *  stale mid-upload) degrades to a normal failed-import error here instead of silently recovering, an
 *  acceptable simplification for what's already a manual retry (re-picking the file) either way, not
 *  worth re-implementing that retry logic a second time against a completely different HTTP API. */
function uploadFormWithProgress<T>(url: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    void (async () => {
      // Hoisted out of the `if` block below (not `const token` scoped inside it) so `xhr.onload`,
      // defined later in this same closure, can read it too — see that handler's own comment on why.
      let token: string | null = null;
      if (HOSTED) {
        token = await getAccessToken();
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onerror = () => reject(new ApiRequestError("Network error", 0));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as T);
          } catch {
            reject(new ApiRequestError("Could not read the server's response", xhr.status));
          }
          return;
        }
        let message = `Request failed (${xhr.status})`;
        let code: string | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; code?: string };
          if (body?.error) message = body.error;
          code = body?.code;
        } catch {
          /* keep the status-based message */
        }
        // `token` (this request's own attached credential, from the closure above), not just "was
        // this a 401" — same reasoning as `unwrap`'s identical fix: a 401 with no token ever attached
        // means this upload was simply never authenticated, not a session that died mid-upload.
        if (xhr.status === 401 && token) sessionExpiredHandler?.();
        reject(new ApiRequestError(message, xhr.status, code));
      };
      xhr.send(form);
    })();
  });
}

/** `projectName` is only ever CONSULTED server-side when no project exists yet at this id — it seeds
 *  the real `project.name` on first creation (see the route's own comment for why that matters: a
 *  host app's title would otherwise never make it past a display-only prop). Ignored entirely for an
 *  already-existing project, which keeps whatever name it was actually given/renamed to. */
export async function loadProject(projectId: string, projectName?: string): Promise<Project> {
  return (await loadProjectWithRevision(projectId, projectName)).project;
}

/** `loadProject` plus the server's `revision` for the file just read — the value the NEXT save must present as
 *  its `baseRevision` so a save from a stale copy (another tab or device saved in between) is refused instead
 *  of overwriting. `null` on native, where a project is a private local file with nobody else writing to it. */
export async function loadProjectWithRevision(projectId: string, projectName?: string): Promise<{ project: Project; revision: number | null }> {
  if (isNative) return { project: await nativeLoadProject(projectId, projectName), revision: null };
  const nameParam = projectName ? `&projectName=${encodeURIComponent(projectName)}` : "";
  const response = await apiFetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}${nameParam}`, { cache: "no-store" });
  const body = await unwrap<{ project: unknown; revision?: number }>(response);
  // Validated on the way in as well as on the way out of the server: a project that can't be read
  // correctly should fail loudly here rather than half-populate the editor.
  return { project: deserializeProject(JSON.stringify(body.project)), revision: typeof body.revision === "number" ? body.revision : 0 };
}

/** A template's own structure and name, for opening it as an unsaved draft — see
 *  `templates/[id]/project/route.ts` and `EditorState.loadTemplateDraft`. */
export async function loadTemplateForDraft(templateId: string): Promise<{ name: string; project: TemplateProjectData }> {
  if (isNative) return nativeLoadTemplateForDraft(templateId);
  const response = await apiFetch(`${BASE}/templates/${encodeURIComponent(templateId)}/project`, { cache: "no-store" });
  return unwrap<{ name: string; project: TemplateProjectData }>(response);
}

/** Creates a real project from a template — the server builds it, and copies the template's bundled
 *  audio into the owner's library (`project/route.ts`'s POST). Only ever called once media is actually
 *  picked for a template draft (`EditorState.commitTemplateDraft`). `draftProject` is only read on
 *  native (`commitTemplateDraft` already has the in-memory draft `loadTemplateDraft` built — see
 *  `nativeCreateProjectFromTemplate`'s own doc comment for why native reuses it instead of asking the
 *  server to rebuild the same thing); the hosted/desktop branch below ignores it and has the server
 *  rebuild from the template itself, same as always. */
export async function createProjectFromTemplate(templateId: string, name: string, draftProject?: Project): Promise<{ projectId: string; name: string }> {
  if (isNative) {
    if (!draftProject) throw new Error("No template draft to start a project from");
    return nativeCreateProjectFromTemplate(templateId, draftProject);
  }
  const response = await apiFetch(`${BASE}/project`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, templateId }),
  });
  const { project } = await unwrap<{ project: { bpProjectId: string; name: string } }>(response);
  return { projectId: project.bpProjectId, name: project.name };
}

export interface SaveProjectOptions {
  /** The revision this copy was loaded at / last saved as. The server refuses the save (409
   *  `revision-conflict`) if the stored project has moved on since. Omitted = unprotected. */
  baseRevision?: number | null;
  /** The user's explicit "keep my version": skip the revision check and overwrite. */
  force?: boolean;
  /** Send with `keepalive` so the browser finishes the request after the page is gone. Ignored (a normal
   *  request is sent) when the body is over ~60KB, the size browsers cap keepalive bodies near. */
  keepalive?: boolean;
}

/** Saves the project. Returns the server's new revision (`null` on native, where there isn't one). Throws an
 *  `ApiRequestError` with `code: "revision-conflict"` (status 409) when another tab or device saved first. */
export async function saveProject(projectId: string, project: Project, options: SaveProjectOptions = {}): Promise<{ revision: number | null }> {
  if (isNative) {
    await nativeSaveProject(projectId, project);
    return { revision: null };
  }
  const body = JSON.stringify({
    project,
    ...(typeof options.baseRevision === "number" ? { baseRevision: options.baseRevision } : null),
    ...(options.force ? { force: true } : null),
  });
  const response = await apiFetch(`${BASE}/project?projectId=${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    ...(options.keepalive && body.length <= KEEPALIVE_MAX_BODY ? { keepalive: true } : null),
  });
  const result = await unwrap<{ ok: boolean; revision?: number }>(response);
  return { revision: typeof result.revision === "number" ? result.revision : null };
}

/** Browsers cap the total size of in-flight `keepalive` request bodies near 64KB; stay comfortably under. */
const KEEPALIVE_MAX_BODY = 60_000;

/** `hiddenFromLibrary`: a stock sound effect or voiceover take, not something the user chose to
 *  import as their own media — see `Asset.hiddenFromLibrary`'s own doc comment for the CLIENT-side
 *  half of this (keeps it off "This project"'s own Media tab). Threaded through to the server as a
 *  separate `hidden` form field so the account-wide "All my media" listing can exclude it too (a real,
 *  reported bug otherwise: every hosted-mode upload lands in the user's library table regardless, so
 *  without this the clip stayed invisible in ITS OWN project's Media tab while still cluttering "All my
 *  media" account-wide, forever). Not sent at all for a plain user upload — `undefined`/`false` both
 *  mean "a normal import," visible in the library exactly as it always has been. */
export async function importMedia(
  projectId: string,
  file: File,
  options?: { hiddenFromLibrary?: boolean; onProgress?: (fraction: number) => void }
): Promise<Asset> {
  if (isNative) return nativeImportMedia(projectId, file);
  const form = new FormData();
  form.append("file", file);
  if (options?.hiddenFromLibrary) form.append("hidden", "1");
  const body = await uploadFormWithProgress<{ asset: Asset }>(
    `${BASE}/media?projectId=${encodeURIComponent(projectId)}`,
    form,
    options?.onProgress
  );
  return body.asset;
}

/** Asks the server to derive a genuinely independent audio-only asset from an already-imported one —
 *  the upgrade `editorStore.ts`'s `extractAudioFromClip` fires off after `ExtractAudioCommand` already
 *  ran (see that command's own doc comment for why the clip already plays without this, and the route's
 *  own doc comment for why a real, separate file is needed at all). Sends where the source file LIVES
 *  (`libraryMediaId`, `bundledSfx`), not just its `relPath` — the route resolves it the same way export
 *  does. Returns `null` on native (no server to ask); throws on failure, so the caller can report it —
 *  this used to swallow every error, which is how a library-backed video never extracting went unseen. */
export async function extractAudioAsset(projectId: string, asset: Asset): Promise<Asset | null> {
  if (isNative) return null;
  const response = await apiFetch(`${BASE}/media/extract-audio?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      relPath: asset.relPath,
      name: asset.name,
      ...(asset.libraryMediaId ? { libraryMediaId: asset.libraryMediaId } : null),
      ...(asset.bundledSfx ? { bundledSfx: true } : null),
    }),
  });
  const body = await unwrap<{ asset: Asset }>(response);
  return body.asset;
}

export async function deleteMedia(projectId: string, asset: Asset): Promise<void> {
  // A text asset has no backing file at all (`relPath` is always `""` — see project/types.ts), so
  // there's nothing on disk to ask the server to remove. Skipping the request entirely rather than
  // sending an empty relPath avoids a pointless round-trip for the one asset kind that never needs it.
  if (!asset.relPath) return;
  if (isNative) return nativeDeleteMedia(projectId, asset);
  const params = new URLSearchParams({ projectId, relPath: asset.relPath });
  if (asset.thumbnailRelPath) params.set("thumbnailRelPath", asset.thumbnailRelPath);
  if (asset.waveformRelPath) params.set("waveformRelPath", asset.waveformRelPath);
  if (asset.proxyRelPath) params.set("proxyRelPath", asset.proxyRelPath);
  await unwrap<{ ok: boolean }>(await apiFetch(`${BASE}/media?${params}`, { method: "DELETE" }));
}

/** Asks the server to make a preview-only H.264 copy of a video the browser couldn't play, returning its
 *  `relPath`. Slow for a long or heavy source (it transcodes), so callers show progress-free "preparing" UI and
 *  do not block on it. Not available on native, where the WebView plays what the device can decode. */
export async function createPlaybackProxy(projectId: string, asset: Asset): Promise<string> {
  if (isNative) throw new ApiRequestError("Preview copies aren't available on this device", 400, "proxy-unavailable");
  const response = await apiFetch(`${BASE}/media/proxy?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath: asset.relPath, ...(asset.libraryMediaId ? { library: true } : null) }),
  });
  const { proxyRelPath } = await unwrap<{ proxyRelPath: string }>(response);
  return proxyRelPath;
}

export interface StockSearchResult {
  id: string;
  kind: "image" | "video";
  /** The result's own title — shown under the tile and used to build a friendly filename. */
  title: string;
  previewUrl: string;
  downloadUrl: string;
  width: number;
  height: number;
  duration?: number;
  user: string;
  pageURL: string;
  /** A fixed license label ("Pexels License") for every result — see `stock/route.ts`'s own comment on
   *  why there's nothing per-result to look up here, unlike Commons' varying per-file CC terms before it. */
  license: string;
}

/** Desktop/browser-server-backed only, same as Remove Object/Captions — Pexels search is proxied
 *  through this app's own server (see `stock/route.ts`'s own doc comment for why: keeping the client
 *  thin and the provider swappable, AND — unlike Commons before it — actually protecting a real secret
 *  key), which native has none of. */
export async function searchStock(
  kind: "image" | "video",
  query: string,
  page = 1
): Promise<{ results: StockSearchResult[]; hasMore: boolean }> {
  const params = new URLSearchParams({ type: kind, q: query, page: String(page) });
  const response = await centralFetch(`/stock?${params}`);
  return unwrap<{ results: StockSearchResult[]; hasMore: boolean }>(response);
}

/** Lands a chosen stock search result as a real project `Asset` — same destination shape `importMedia`
 *  produces for an uploaded file, just sourced from a URL instead of a `File`. The name sent/used is
 *  the result's own `title` (a bare numeric id alone makes a poor display name) — but the real
 *  EXTENSION always comes from `downloadUrl` itself, never guessed: import classifies (and rejects)
 *  purely by extension, so a synthetic name with no extension at all would fail to import every time.
 *
 *  On the native (Capacitor) shell, there is no local server at all to relay this through — but
 *  `downloadUrl` is always a plain PUBLIC Pexels CDN link (`images.pexels.com`/`videos.pexels.com`,
 *  confirmed against `stock/route.ts`'s own SSRF allowlist), needing no secret key to fetch, only the
 *  SEARCH step did. So mobile downloads the file itself and imports it through the exact same
 *  `nativeImportMedia` path a locally-picked file already goes through — no server round trip for the
 *  actual bytes at all. Desktop keeps going through its OWN bundled local server unchanged (relative
 *  `apiFetch`, `stock/route.ts`'s `POST`, still `localRoute`-gated, no CORS/secret-key needed for this
 *  step either) — that route already lands the file straight into the user's own local project. */
export async function importStockResult(projectId: string, result: StockSearchResult): Promise<Asset> {
  const urlExt = result.downloadUrl.split(/[?#]/)[0].split(".").pop();
  const ext = urlExt && urlExt.length <= 5 ? urlExt : result.kind === "video" ? "mp4" : "jpg";
  const friendly = result.title.trim().replace(/[^a-zA-Z0-9-]+/g, "-") || "stock";
  const fileName = `${friendly}-${result.id}.${ext}`;

  if (isNative) {
    const download = await fetch(result.downloadUrl);
    if (!download.ok) throw new ApiRequestError("Couldn't download that stock result", download.status, "stock-download-failed");
    const blob = await download.blob();
    return nativeImportMedia(projectId, new File([blob], fileName, { type: blob.type }));
  }

  const response = await apiFetch(`${BASE}/stock?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: result.downloadUrl, name: fileName }),
  });
  const body = await unwrap<{ asset: Asset }>(response);
  return body.asset;
}

/** One Stickers-tool search result — see `stickers/route.ts` (`_lib/stickerProviders.ts`). */
export interface StickerSearchResult {
  id: string;
  provider: StickerProvider;
  type: StickerType;
  title: string;
  previewUrl: string;
  width: number;
  height: number;
  downloadUrl: string;
}

/** Which sticker providers this server has keys for, and what a GIPHY pick costs (0 off hosted). */
export interface StickerAvailability {
  klipy: boolean;
  giphy: boolean;
  giphyCredits: number;
}

export async function getStickerAvailability(): Promise<StickerAvailability> {
  const response = await centralFetch(`/stickers?availability=1`);
  return unwrap<StickerAvailability>(response);
}

/** Trending when `query` is empty. */
export async function searchStickers(
  provider: StickerProvider,
  type: StickerType,
  query: string,
  page = 1
): Promise<{ results: StickerSearchResult[]; hasMore: boolean }> {
  const params = new URLSearchParams({ provider, type, q: query, page: String(page) });
  const response = await centralFetch(`/stickers?${params}`);
  return unwrap<{ results: StickerSearchResult[]; hasMore: boolean }>(response);
}

/** Lands a picked sticker/GIF as an animated image `Asset` (see `stickers.ts`). A GIPHY pick spends
 *  real credits; KLIPY is free.
 *
 *  Same native/desktop split as `importStockResult`, for the same reason: `result.downloadUrl` is
 *  always a plain public KLIPY/GIPHY CDN link (confirmed against `stickerProviders.ts`'s own
 *  `isAllowedStickerDownload` allowlist), so mobile downloads and imports it itself with no server
 *  relay needed for the bytes — but a GIPHY pick still needs the real charge to happen SERVER-side
 *  (the client can't be trusted to self-report "please charge me"), so mobile makes one extra call to
 *  `stickers/charge` afterward, purely to bill it — see that route's own doc comment. Charging AFTER a
 *  successful import (not before, unlike desktop's server-side flow) means a failed import is never
 *  charged; the tiny reverse race that opens (a slow/duplicate charge call after one real import) isn't
 *  a realistic concern for a single interactive pick. */
export async function importSticker(projectId: string, result: StickerSearchResult): Promise<Asset> {
  if (isNative) {
    const download = await fetch(result.downloadUrl);
    if (!download.ok) throw new ApiRequestError("Couldn't download that sticker", download.status, "sticker-download-failed");
    const blob = await download.blob();
    const friendly = result.title.trim().replace(/[^a-zA-Z0-9-]+/g, "-") || (result.type === "gifs" ? "gif" : "sticker");
    const asset = await nativeImportMedia(projectId, new File([blob], `${friendly}.gif`, { type: blob.type || "image/gif" }));
    if (result.provider === "giphy") {
      await unwrap<{ ok: true }>(
        await centralFetch(`/stickers/charge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: result.provider }),
        })
      );
    }
    return asset;
  }

  const response = await apiFetch(`${BASE}/stickers?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: result.provider, type: result.type, id: result.id, url: result.downloadUrl, name: result.title }),
  });
  const body = await unwrap<{ asset: Asset }>(response);
  return body.asset;
}

/** An animated image's preview sprite sheet (`Asset.animation.spriteRelPath`, stored with thumbnails),
 *  or `null` for anything else. */
export function stickerSpriteUrl(projectId: string, asset: Asset): string | null {
  if (!asset.animation) return null;
  return `${mediaUrl(projectId, asset.animation.spriteRelPath, Boolean(asset.libraryMediaId))}&kind=thumbnail`;
}

/** Every aspect ratio both AI generation routes accept (`ai-image/route.ts`'s Flux Schnell and
 *  `ai-video/route.ts`'s Seedance 2.0 both happen to support exactly the same three) — kept here so
 *  the UI can build its pickers off one shared list rather than two hand-copied ones that could drift
 *  out of sync. */
export const AI_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type AiAspectRatio = (typeof AI_ASPECT_RATIOS)[number];

/** The three image-generation models `ai-image/route.ts` offers — kept here (rather than each caller
 *  hand-copying its own list) for the same "one shared source, can't drift" reason `AI_ASPECT_RATIOS`
 *  already is. Order matches the route's own MODELS record: default, premium, alternative. */
export const AI_IMAGE_MODELS = ["flare", "sunburst", "nano-banana-2"] as const;
export type AiImageModel = (typeof AI_IMAGE_MODELS)[number];

/** Plain browser-safe base64 decode (`atob`, not Node's `Buffer`) — used for the raw generated bytes
 *  `centralFetch`-routed AI routes hand back inline (`deliverBytes: true`) so desktop/mobile can save
 *  a local copy in one round trip instead of a second fetch back down from vcut.io's own library. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Generates one image from a text prompt via the server's Replicate-backed route and lands it as a
 *  real project `Asset` — a plain request/response, not a job+SSE watch, because every model the route
 *  offers is fast enough not to need one (see `ai-image/route.ts`'s own comment).
 *
 *  Routes through `centralFetch` like Stock/Stickers search — same reason: the secret Replicate token
 *  only lives on the live vcut.io deployment now. Unlike Stock/Stickers, generation has no public-CDN
 *  download to fall back on for the actual bytes (the whole call needs the secret key), so `!HOSTED`
 *  callers (desktop AND mobile, not just native) ask the route to also hand the bytes straight back
 *  (`deliverBytes: true`) and finish the job with the EXACT SAME `importMedia` a locally-picked file
 *  already goes through — that function already knows how to land bytes locally on both platforms
 *  (desktop's own bundled server, or `nativeImportMedia` on mobile), so there's no new per-platform
 *  branch to write here at all. */
export async function generateAiImage(
  projectId: string,
  prompt: string,
  aspectRatio: AiAspectRatio,
  model: AiImageModel
): Promise<Asset> {
  const deliverBytes = !HOSTED;
  const response = await centralFetch(`/ai-image?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspectRatio, model, deliverBytes }),
  });
  const body = await unwrap<{ asset: Asset; bytesBase64?: string }>(response);
  if (!body.bytesBase64) return body.asset;
  const file = new File([base64ToBytes(body.bytesBase64).buffer as ArrayBuffer], body.asset.name, { type: "image/png" });
  return importMedia(projectId, file);
}

/** Whether AI image generation is usable right now (a Replicate token is configured server-side). */
export async function aiImageAvailable(): Promise<boolean> {
  try {
    const response = await centralFetch(`/ai-image`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}

/** Searches the music catalog by category and optional query string. */
export async function searchMusic(category: MusicCategory = "all", query: string = ""): Promise<{ tracks: MusicTrack[] }> {
  const params = new URLSearchParams();
  if (category && category !== "all") params.set("category", category);
  if (query.trim()) params.set("q", query.trim());
  const response = await centralFetch(`/music?${params.toString()}`);
  return unwrap<{ tracks: MusicTrack[] }>(response);
}

/** Imports a music track into the project media library and returns an Asset. */
export async function importMusicTrack(projectId: string, track: MusicTrack): Promise<Asset> {
  const deliverBytes = !HOSTED;
  const response = await centralFetch(`/music?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trackId: track.id,
      audioUrl: track.audioUrl,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
      deliverBytes,
    }),
  });
  const body = await unwrap<{ asset: Asset; bytesBase64?: string }>(response);
  if (!body.bytesBase64) return body.asset;
  const file = new File([base64ToBytes(body.bytesBase64).buffer as ArrayBuffer], body.asset.name, { type: "audio/mpeg" });
  return importMedia(projectId, file);
}

/** AI Background Remover — automatically cuts out subjects from an image (or extracts video frame)
 *  and returns a new transparent PNG Asset. */
export async function removeBackground(projectId: string, assetId?: string, clipId?: string, timeSeconds?: number): Promise<Asset> {
  const deliverBytes = !HOSTED;
  const response = await centralFetch(`/ai-background-remove?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId, clipId, deliverBytes, timeSeconds }),
  });
  const body = await unwrap<{ asset: Asset; bytesBase64?: string }>(response);
  if (!body.bytesBase64) return body.asset;
  const file = new File([base64ToBytes(body.bytesBase64).buffer as ArrayBuffer], body.asset.name, { type: "image/png" });
  return importMedia(projectId, file);
}

/** AI Edit — applies user's text prompt to an image/video frame using instruction-based editing. */
export async function runAiEdit(
  projectId: string,
  assetId: string,
  clipId: string | undefined,
  prompt: string,
  strength: "subtle" | "balanced" | "creative" = "balanced",
  timeSeconds?: number
): Promise<Asset> {
  const deliverBytes = !HOSTED;
  const response = await centralFetch(`/ai-edit?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId, clipId, prompt, strength, deliverBytes, timeSeconds }),
  });
  const body = await unwrap<{ asset: Asset; bytesBase64?: string }>(response);
  if (!body.bytesBase64) return body.asset;
  const file = new File([base64ToBytes(body.bytesBase64).buffer as ArrayBuffer], body.asset.name, { type: "image/png" });
  return importMedia(projectId, file);
}

export interface AiVideoStarted {
  jobId: string;
}

export interface AiVideoProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "predicting" | "downloading" | "importing";
  progress: number;
  error?: string;
  /** Present once `status === "done"` — same "land it directly, no second round-trip" shape
   *  `InpaintProgress.asset` already uses. */
  asset?: Asset;
  /** Present once `status === "done"`, only when this call asked for it (`!HOSTED`) — see
   *  `ai-video/route.ts`'s own `AiVideoJob.bytesBase64` doc comment. */
  bytesBase64?: string;
}

/** Starts an AI video generation job from a text prompt (`ai-video/route.ts`, Replicate's
 *  `bytedance/seedance-2.0`) — a real job+SSE flow, unlike AI image gen, because a single generation
 *  takes minutes rather than seconds. Routes through `centralFetch` like `generateAiImage` — same
 *  reasoning, see that function's own doc comment. `deliverBytes` here just starts the job with that
 *  flag remembered server-side; the actual bytes (if requested) arrive in `watchAiVideo`'s own final
 *  `done` event, not this response — the job hasn't produced anything yet when this returns. */
export async function startAiVideo(projectId: string, prompt: string, aspectRatio: AiAspectRatio): Promise<AiVideoStarted> {
  const response = await centralFetch(`/ai-video?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspectRatio, deliverBytes: !HOSTED }),
  });
  return unwrap<AiVideoStarted>(response);
}

export async function cancelAiVideo(jobId: string): Promise<void> {
  // A cancel racing the job's own completion is normal, not an error worth surfacing — same
  // reasoning as `cancelInpaint`/`cancelExport`.
  await centralFetch(`/ai-video?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to an AI video generation job's progress. Identical shape to `watchInpaint` — see its
 *  own comment for why `EventSource` over polling. Once `status === "done"` carries a `bytesBase64`
 *  (desktop/mobile only — see `startAiVideo`'s own `deliverBytes`), lands it locally through the exact
 *  same `importMedia` a locally-picked file already goes through, same as `generateAiImage`, and swaps
 *  it into the `asset` field the caller actually reads before handing the update to `onUpdate` — the
 *  caller never needs to know this extra step happened. */
export function watchAiVideo(
  projectId: string,
  jobId: string,
  onUpdate: (progress: AiVideoProgress) => void,
  onError: (message: string) => void
): () => void {
  const source = new EventSource(centralSseUrl(`${BASE}/ai-video?jobId=${encodeURIComponent(jobId)}`));

  source.onmessage = (event) => {
    void (async () => {
      try {
        const payload = JSON.parse(event.data) as AiVideoProgress;
        if (payload.status === "done" && payload.bytesBase64 && payload.asset) {
          const file = new File([base64ToBytes(payload.bytesBase64).buffer as ArrayBuffer], payload.asset.name, { type: "video/mp4" });
          payload.asset = await importMedia(projectId, file);
        }
        onUpdate(payload);
        if (payload.status !== "running") source.close();
      } catch {
        /* a malformed frame is not worth tearing the stream down over */
      }
    })();
  };

  source.onerror = () => {
    // See `watchInpaint`'s own comment on this exact check — `CONNECTING` means EventSource is
    // already retrying a dropped connection on its own; only `CLOSED` means the browser gave up.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the job. It may still be running.");
    }
  };

  return () => source.close();
}

/** Whether AI video generation is usable right now (a Replicate token is configured server-side). */
export async function aiVideoAvailable(): Promise<boolean> {
  try {
    const response = await centralFetch(`/ai-video`, { method: "HEAD" });
    return response.status === 204;
  } catch {
    return false;
  }
}

/** URL for the actual media bytes — what a `<video>`/`<audio>` element's `src` points at. The route
 *  behind it supports HTTP Range, which is what makes seeking possible (native uses
 *  `Capacitor.convertFileSrc`, whose local scheme handler supports Range natively too).
 *
 *  In the hosted build, this is genuinely per-user, ownership-checked content — unlike bundled fonts/
 *  SFX (see `sfxAssetUrl` below), which needed the opposite fix (no auth at all) since those are
 *  identical for every user. A plain `<video src>`/`<img src>` load can't attach an `Authorization`
 *  header the way `apiFetch`'s JSON calls do, so the token rides along as a `?token=` query param
 *  instead — `_lib/auth.ts`'s `requireSessionUser` accepts either. Uses `getCachedAccessToken`, the
 *  synchronous accessor, since this function itself is called synchronously all over the render tree
 *  (`<video src={mediaUrl(...)}>`) with nowhere to await a fresh token; whatever's cached from the
 *  last `onAuthStateChange` event is at most a few seconds stale, never actually wrong. Confirmed as
 *  a real production gap, not theoretical: every clip/thumbnail/waveform 401'd on the real vcut.io
 *  deploy before this existed. */
/** `library`: true for an asset carrying `Asset.libraryMediaId` — its real bytes live in the current
 *  user's own account-wide `users/<id>/media` directory, not this project's own folder (see that
 *  field's own doc comment), so the server has to be told which one to resolve `relPath` against. */
export function mediaUrl(projectId: string, relPath: string, library = false): string {
  if (isNative) return nativeMediaUrl(projectId, relPath);
  const libraryParam = library ? "&library=1" : "";
  // An empty `projectId` is only meaningful for a library file — see `media/raw/route.ts`: a template
  // opened as a draft (`TemplateDraftApp`) shows your library before any project exists.
  const projectParam = projectId ? `projectId=${encodeURIComponent(projectId)}&` : "";
  const base = `${BASE}/media/raw?${projectParam}relPath=${encodeURIComponent(relPath)}${libraryParam}`;
  if (!HOSTED) return base;
  const token = getCachedAccessToken();
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

export function thumbnailUrl(projectId: string, asset: Asset): string | null {
  const library = Boolean(asset.libraryMediaId);
  // Images are their own preview; everything else needs a generated thumbnail to have one.
  if (asset.kind === "image") return mediaUrl(projectId, asset.relPath, library);
  if (!asset.thumbnailRelPath) return null;
  return `${mediaUrl(projectId, asset.thumbnailRelPath, library)}&kind=thumbnail`;
}

/** URL for one of the two bundled outro images (`OUTRO_LOGO_FILE`/`OUTRO_BG_FILE` in
 *  `export/outro.ts`), served by `outro-assets/[file]/route.ts`. Bundled app assets, not per-project
 *  or per-user content — no `projectId`/auth token needed, same simplicity as the font files served
 *  from `fonts/[file]`. `Preview.tsx`'s own `mediaUrlFor` is the one caller: it special-cases the two
 *  fixed outro asset ids to resolve here instead of the normal per-project `mediaUrl` lookup. */
export function outroAssetUrl(file: string): string {
  return `${BASE}/outro-assets/${encodeURIComponent(file)}`;
}

/** The multi-frame sprite `TimelineClip` tiles for a filmstrip — `null` for anything that doesn't have
 *  one (audio, text, images, or a video imported before this existed), in which case the caller falls
 *  back to `thumbnailUrl`'s single frame. */
export function filmstripUrl(projectId: string, asset: Asset): string | null {
  if (!asset.filmstripRelPath) return null;
  return `${mediaUrl(projectId, asset.filmstripRelPath, Boolean(asset.libraryMediaId))}&kind=thumbnail`;
}

/** A waveform PNG spanning the asset's FULL duration — `null` for anything that doesn't have one
 *  (non-audio, or an audio file FFmpeg couldn't read). `TimelineClip` stretches/positions it via CSS
 *  to match each clip's own trim, the same way `filmstripUrl`'s sprite is tiled rather than the
 *  frontend doing any per-clip image generation of its own. */
export function waveformUrl(projectId: string, asset: Asset): string | null {
  if (!asset.waveformRelPath) return null;
  // Bundled catalog SFX (`Asset.bundledSfx`) never had a per-project waveform generated at all — its
  // `waveformRelPath` names a sibling file in the app's own shared `assets/sfx/` directory instead
  // (see that field's own doc comment), resolved through the same unauthenticated bundled-asset route
  // `sfxAssetUrl` uses rather than this project's own `media/raw`.
  if (asset.bundledSfx) return sfxWaveformUrl(asset.waveformRelPath);
  return `${mediaUrl(projectId, asset.waveformRelPath, Boolean(asset.libraryMediaId))}&kind=thumbnail`;
}

export function exportUrl(projectId: string, fileName: string): string {
  return `${mediaUrl(projectId, fileName)}&kind=export`;
}

/** One row of the current user's account-wide media library (`GET /api/vcut/media/library`) — every
 *  import, AI generation, and stock download across every one of their projects, not just this one.
 *  Field shape mirrors `Asset` closely on purpose: turning one into a placeable `Asset` (see
 *  `assetFromLibraryMedia` below) is then just adding the two fields a library row doesn't need
 *  (`importedAt`, `libraryMediaId`), not a real mapping. */
export interface LibraryMediaItem {
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  relPath: string;
  thumbnailRelPath: string | null;
  filmstripRelPath: string | null;
  waveformRelPath: string | null;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  sizeBytes: number;
  aiGeneration: { prompt: string; aspectRatio: string; model?: string } | null;
  createdAt: string;
}

/** Hosted-web only — desktop/local dev has no account for a cross-project library to belong to (every
 *  asset there stays project-local, exactly as before this existed), so this simply never gets called
 *  from that build. */
export async function listLibraryMedia(): Promise<{ items: LibraryMediaItem[]; usedBytes: number; capBytes: number }> {
  const response = await apiFetch(`${BASE}/media/library`);
  return unwrap(response);
}

/** Turns a library row into a real, placeable project `Asset` — purely client-side, no round trip:
 *  every field a fresh `Asset` needs is already sitting in the row `listLibraryMedia` returned. A new
 *  random `id` (not the library row's own id) so two different projects placing the SAME library item
 *  each get their own independent asset entry — `libraryMediaId` (not `id`) is what ties them back to
 *  the one shared underlying file (see `Asset.libraryMediaId`'s own doc comment), and what
 *  `findProjectsUsingMedia` scans for on the server when a library delete needs to warn about
 *  cross-project usage. */
export function assetFromLibraryMedia(item: LibraryMediaItem): Asset {
  return {
    id: crypto.randomUUID(),
    kind: item.kind,
    name: item.name,
    relPath: item.relPath,
    ...(item.thumbnailRelPath ? { thumbnailRelPath: item.thumbnailRelPath } : null),
    ...(item.filmstripRelPath ? { filmstripRelPath: item.filmstripRelPath } : null),
    ...(item.waveformRelPath ? { waveformRelPath: item.waveformRelPath } : null),
    duration: item.duration,
    ...(item.width != null ? { width: item.width } : null),
    ...(item.height != null ? { height: item.height } : null),
    ...(item.fps != null ? { fps: item.fps } : null),
    hasAudio: item.hasAudio,
    sizeBytes: item.sizeBytes,
    importedAt: Date.now(),
    ...(item.aiGeneration ? { aiGeneration: item.aiGeneration } : null),
    libraryMediaId: item.id,
  };
}

/** A read-only stand-in `Asset` for a library row that ISN'T (yet) part of the CURRENT project — just
 *  enough shape for a thumbnail/preview to render it. Deliberately NOT `assetFromLibraryMedia` above:
 *  that one mints a fresh random `id` every call (correct for actually PLACING a library item, where
 *  two projects placing the same file need independent asset ids), which would break a React `key` and
 *  any "already added?" comparison on every re-render. This one keeps `id: item.id` stable instead —
 *  never appended to `project.assets`, so there's no cross-project id collision risk to worry about
 *  here the way there would be for a real placement. Shared by `MediaLibrary.tsx`'s own "All my media"
 *  view and `AiGeneratePanel.tsx`'s own "All my generations" view — both need the identical conversion,
 *  just filtered to a different subset of the same library listing. */
export function previewAssetFromLibraryMedia(item: LibraryMediaItem): Asset {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    relPath: item.relPath,
    ...(item.thumbnailRelPath ? { thumbnailRelPath: item.thumbnailRelPath } : null),
    ...(item.filmstripRelPath ? { filmstripRelPath: item.filmstripRelPath } : null),
    ...(item.waveformRelPath ? { waveformRelPath: item.waveformRelPath } : null),
    duration: item.duration,
    ...(item.width != null ? { width: item.width } : null),
    ...(item.height != null ? { height: item.height } : null),
    ...(item.fps != null ? { fps: item.fps } : null),
    hasAudio: item.hasAudio,
    sizeBytes: item.sizeBytes,
    importedAt: new Date(item.createdAt).getTime(),
    ...(item.aiGeneration ? { aiGeneration: item.aiGeneration } : null),
    libraryMediaId: item.id,
  };
}

/** A non-forced delete finding the item still in use is an expected, common outcome — not a failure —
 *  so it comes back as a real return value the caller branches on, rather than an exception to catch.
 *  Pass `force: true` only on a SECOND call, after the caller already showed the user this result's own
 *  `projects` list as a warning and they chose to proceed anyway. */
export type LibraryDeleteResult = { deleted: true } | { deleted: false; usedByProjects: { id: string; name: string }[] };

export async function deleteLibraryMedia(id: string, force = false): Promise<LibraryDeleteResult> {
  const params = new URLSearchParams({ id });
  if (force) params.set("force", "1");
  const response = await apiFetch(`${BASE}/media/library?${params}`, { method: "DELETE" });
  if (response.status === 409) {
    const body = (await response.json()) as { projects: { id: string; name: string }[] };
    return { deleted: false, usedByProjects: body.projects };
  }
  await unwrap(response);
  return { deleted: true };
}

/** URL for one bundled `SFX_REGISTRY` catalog entry's audio file (`project/sfx.ts`'s own `file`) —
 *  served as a plain static asset, not project-scoped the way `mediaUrl` is: a bundled sound effect
 *  isn't stored per-project, it ships with the app the same way a bundled font's `.ttf` does (see
 *  `fonts.ts`'s own `resolveFontVariant` doc comment for the matching "packages/vcut/assets/" bundled-
 *  file convention this mirrors, one directory over — `packages/vcut/assets/sfx/`).
 *
 *  Routed through `sfx/[file]/route.ts` (`_lib/sfx.ts`'s `sfxAssetPath`), same as every other bundled
 *  asset this app serves via its own API route rather than Next's `public/` static folder — there's
 *  no `studios/vcut/public/sfx/` directory for a bare `/sfx/${file}` to ever resolve against.
 *
 *  Absolute (`https://vcut.io`) when `!HOSTED`, same as `centralFetch`'s Stock/Stickers/AI routing —
 *  a real, confirmed gap, not a theoretical one: unlike THOSE routes, this one was never given the
 *  same treatment, so it stayed a bare relative `${BASE}/sfx/${file}`, which resolves against
 *  `capacitor://localhost` on the native shell — there is no server there AT ALL to answer it, so
 *  every SFX preview, add-to-timeline, and playback of an already-placed bundled SFX clip
 *  (`Preview.tsx`'s `mediaUrlFor`, which calls this same function) failed outright on Android/iOS.
 *  The route itself needs no auth (`publicAssetRoute`, identical content for every user), so — unlike
 *  `centralFetch` — this needs no bearer token, only the absolute URL; `sfx/[file]/route.ts` was given
 *  its own `Access-Control-Allow-Origin: *` alongside this fix so a native `fetch().blob()` (not just
 *  an `<audio src>`, which never needed CORS to begin with) can read the response cross-origin too. */
export function sfxAssetUrl(file: string): string {
  const path = `${BASE}/sfx/${file}`;
  return HOSTED ? path : `https://vcut.io${path}`;
}

/** URL for a bundled `SFX_REGISTRY` entry's pre-generated waveform PNG (`sfxMetadata.generated.ts`'s
 *  own `SFX_METADATA[file].waveformFile`) — same bundled, unauthenticated `sfx/[file]/route.ts` route
 *  `sfxAssetUrl` uses, since the waveform is just a plain sibling file in that same directory (see that
 *  generated file's own doc comment for why there's no separate directory/route for it). */
export function sfxWaveformUrl(file: string): string {
  return sfxAssetUrl(file);
}

/** URL for one entry in the project's own "My Sounds" library (`project.customSfx`) — reuses
 *  `mediaUrl`'s exact same project-relative-path convention a placed `Asset` uses, since a
 *  `CustomSfxAsset` lives in the SAME project media tree, just not itself placed on the timeline (see
 *  `CustomSfxAsset`'s own doc comment for why it's a separate library, not a plain `Asset`). */
export function customSfxUrl(projectId: string, sfx: CustomSfxAsset): string {
  return `${mediaUrl(projectId, sfx.relPath)}&kind=customSfx`;
}

/** Imports a file into the project's own "My Sounds" library — same `FormData` upload shape as
 *  `importMedia`, against a dedicated route so the result lands in `project.customSfx` (a reusable
 *  library entry) rather than `project.assets` (a placeable clip source); see `CustomSfxAsset`'s own
 *  doc comment for why the two are kept separate. No native branch yet — same v1 scope cut
 *  `startInpaint`/`startCaptions` already document for a feature that needs the desktop/browser server,
 *  not (yet) the on-device native shell. */
export async function importCustomSfx(projectId: string, file: File): Promise<CustomSfxAsset> {
  if (isNative) throw new ApiRequestError("Importing sound effects isn't available on this device yet.", 501, "sfx-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await apiFetch(`${BASE}/sfx?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ sfx: CustomSfxAsset }>(response);
  return body.sfx;
}

/** Removes one "My Sounds" library entry — `sfxId`-keyed, matching `sfx/route.ts`'s own `DELETE`
 *  handler exactly (it looks the entry up by id to find its own `relPath` server-side). Resolves once
 *  the file is actually gone; does NOT hand back an updated `Project` — see `deleteLut`'s own doc
 *  comment for why the caller must apply this removal to its own current in-memory project instead
 *  of trusting a server-returned one. */
export async function deleteCustomSfx(projectId: string, sfx: CustomSfxAsset): Promise<void> {
  // Unreachable in practice today — `importCustomSfx` already refuses on native, so there's never a
  // "My Sounds" entry to remove there — but throws rather than silently no-opping for the same
  // "surface the real reason, don't pretend it worked" consistency `importLut`/`importCustomFont` give.
  if (isNative) throw new ApiRequestError("Removing sound effects isn't available on this device yet.", 501, "sfx-unavailable");
  const params = new URLSearchParams({ projectId, sfxId: sfx.id });
  await unwrap<{ ok: boolean }>(await apiFetch(`${BASE}/sfx?${params}`, { method: "DELETE" }));
}

/** URL for one entry in the project's own LUT library (`project.luts`) — a fetchable `.cube` text file,
 *  same `media/raw`-route-with-a-`kind`-tag shape `thumbnailUrl`/`filmstripUrl` already use, just
 *  `kind=lut` instead of `kind=thumbnail` (see that route's own `CONTENT_TYPES`/`baseDir` comment for
 *  why `.cube` is served through this same generic route rather than a dedicated one). Read by
 *  `PlaybackEngine.lutUrlFor` (live preview) — export never fetches this URL at all, it hands FFmpeg
 *  the LUT's real on-disk path directly (`export/lutFilter.ts`). */
export function lutUrl(projectId: string, lut: LutAsset): string {
  return `${mediaUrl(projectId, lut.relPath)}&kind=lut`;
}

/** Imports a `.cube` file into the project's own LUT library — same `FormData` upload shape as
 *  `importCustomSfx`, against `lut/route.ts` instead. No native branch yet, same v1 scope cut. */
export async function importLut(projectId: string, file: File): Promise<LutAsset> {
  if (isNative) throw new ApiRequestError("Importing LUTs isn't available on this device yet.", 501, "lut-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await apiFetch(`${BASE}/lut?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ lut: LutAsset }>(response);
  return body.lut;
}

/** Removes a LUT from the project's library — `lut/route.ts`'s own `DELETE` deletes the file and
 *  keeps its own on-disk copy of the project consistent (dropping the `LutAsset` entry and cascading
 *  the `lutId` clear across every clip that referenced it), but does NOT hand back an updated
 *  `Project`. An earlier version of both this function and that route did — a server-computed result
 *  sounds like the more trustworthy one to apply, but the route's own `project` is a snapshot read
 *  fresh off disk at request time, which is routinely STALER than the calling tab's real in-memory
 *  state (autosave is debounced ~1.5s — `editorStore.ts`'s own `AUTOSAVE_DELAY_MS`). Swapping that
 *  snapshot in wholesale silently discarded whatever the user had edited since their last autosave,
 *  on every single delete — not a race, not an edge case. The caller applies this same removal (and,
 *  for a LUT specifically, the same `removeLutReferences` cascade) to its OWN current in-memory
 *  project instead (`editorStore.ts`'s `removeLut`) — this call now only confirms the file is gone. */
export async function deleteLut(projectId: string, lutId: string): Promise<void> {
  if (isNative) throw new ApiRequestError("Removing LUTs isn't available on this device yet.", 501, "lut-unavailable");
  const params = new URLSearchParams({ projectId, lutId });
  await unwrap<{ ok: boolean }>(await apiFetch(`${BASE}/lut?${params}`, { method: "DELETE" }));
}

/** URL for one entry in the project's own custom-font library (`project.customFonts`) — same
 *  `kind`-tagged `media/raw` shape as `lutUrl`, just `kind=customFont`. Fetched by
 *  `registerCustomFont` (`project/fonts.ts`) to construct the real `FontFace` a bundled font's static
 *  `@font-face` rule already gives it for free. */
export function customFontUrl(projectId: string, font: CustomFontAsset): string {
  return `${mediaUrl(projectId, font.relPath)}&kind=customFont`;
}

/** Imports a `.ttf`/`.otf` file into the project's own custom-font library — same shape as
 *  `importCustomSfx`, against `fonts/route.ts` instead. */
export async function importCustomFont(projectId: string, file: File): Promise<CustomFontAsset> {
  if (isNative) throw new ApiRequestError("Importing fonts isn't available on this device yet.", 501, "font-unavailable");
  const form = new FormData();
  form.append("file", file);
  const response = await apiFetch(`${BASE}/fonts?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: form,
  });
  const body = await unwrap<{ font: CustomFontAsset }>(response);
  return body.font;
}

/** Removes one custom-font library entry — same `id`-keyed delete shape `fonts/route.ts`'s own
 *  `DELETE` expects (a custom font needs no clip-level cascade — see that route's own doc comment for
 *  why `fontById`'s existing fallback already covers it). Does NOT hand back an updated `Project` —
 *  see `deleteLut`'s own doc comment for why the caller applies this removal to its own current
 *  in-memory project instead of trusting a server-returned one. */
export async function deleteCustomFont(projectId: string, font: CustomFontAsset): Promise<void> {
  if (isNative) throw new ApiRequestError("Removing fonts isn't available on this device yet.", 501, "font-unavailable");
  const params = new URLSearchParams({ projectId, fontId: font.id });
  await unwrap<{ ok: boolean }>(await apiFetch(`${BASE}/fonts?${params}`, { method: "DELETE" }));
}

export interface ExportStarted {
  jobId: string;
  fileName: string;
  duration: number;
}

export interface ExportProgress {
  status: "running" | "done" | "failed" | "cancelled";
  /** `preparing`/`rendering-text` cover everything before FFmpeg exists to report a real `progress`
   *  fraction (the Khmer pre-pass's own browser launch and per-clip text rendering) — `message` is a
   *  human-readable status for exactly those two phases; `encoding` is everything after, where
   *  `progress` is the meaningful number. Optional (native mobile export has no such pre-pass phase
   *  at all — see `nativeExport.ts` — so its own progress payloads never set this). */
  phase?: "preparing" | "rendering-text" | "encoding";
  message?: string;
  progress: number;
  fileName: string;
  error?: string;
}

export async function startExport(projectId: string, project: Project, fileName?: string): Promise<ExportStarted> {
  if (isNative) return nativeStartExport(projectId, project, fileName);
  const response = await apiFetch(`${BASE}/export?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, fileName }),
  });
  return unwrap<ExportStarted>(response);
}

/** Finds the currently-running export for a project, if any — `null` when nothing's running.
 *  `startExport` rejects a second concurrent export for the same project (see its own route's doc
 *  comment), which is correct for a genuine double-submit but leaves nothing for a FRESH dialog to
 *  do with that 409 by itself: a page reload, a second tab, or just re-opening the dialog after
 *  closing it all lose the in-memory `jobIdRef` a running export needs to be watched or cancelled by.
 *  This is what lets the dialog recover from any of those — see its own call site. */
export async function findRunningExport(projectId: string): Promise<string | null> {
  if (isNative) return null; // native export has no server-side job registry to look one up in
  const response = await apiFetch(`${BASE}/export?projectId=${encodeURIComponent(projectId)}`);
  const { jobId } = await unwrap<{ jobId: string | null }>(response);
  return jobId;
}

export async function cancelExport(jobId: string): Promise<void> {
  if (isNative) return nativeCancelExport(jobId);
  // A cancel racing the job's own completion is normal, not an error worth surfacing.
  await apiFetch(`${BASE}/export?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to an export's progress. Returns an unsubscribe function that also closes the stream.
 *
 *  Uses `EventSource` rather than polling so the UI updates as FFmpeg reports progress, with no
 *  request storm and no artificial lag between the render finishing and the user being told. */
export function watchExport(
  jobId: string,
  onUpdate: (progress: ExportProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) return nativeWatchExport(jobId, onUpdate, onError);
  const source = new EventSource(sseUrl(`${BASE}/export?jobId=${encodeURIComponent(jobId)}`));

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as ExportProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // `readyState` tells apart two very differently-shaped situations `onerror` fires for, and only
    // one of them is a real failure. `CONNECTING` means the browser's own EventSource just lost the
    // connection and is ALREADY retrying it on its own (the platform-standard behavior — no code here
    // makes that happen) — exactly what a plain network blip, a proxy/browser recycling a
    // long-idle-looking connection, or a laptop waking from sleep looks like, and utterly routine for
    // an export that runs several minutes. `CLOSED` means the browser gave up retrying for good
    // (a non-2xx response, e.g. the 404 `job-missing` the route throws once a finished job's own
    // cleanup timer removes it, or the dev server restarting mid-export) — that one really is over.
    // Calling `close()` unconditionally here (an earlier version of this did) used to treat the FIRST
    // case as fatal too, tearing down the very retry already in flight and orphaning the UI from a
    // job that was still running server-side the whole time. Confirmed as the actual cause of exports
    // reported as silently "not working": a 60fps/High-quality render can run many minutes longer
    // than the defaults, which doesn't break anything about FFmpeg — it just keeps the connection
    // open long enough to hit an ordinary drop before finishing, which the defaults rarely do.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the export. It may still be running.");
    }
  };

  return () => source.close();
}

/** Whether export can actually work right now — on native, whether the `Ffmpeg` plugin registered
 *  (see `FfmpegPlugin.kt`); on the server, whether FFmpeg is present and runnable. `reason`, when
 *  present, is the SERVER's own captured explanation (see `_lib/ffmpeg.ts`'s `ffmpegAvailable`) —
 *  carried over the one channel a HEAD response can actually use for it (a custom header; HEAD
 *  responses can't have a body at all). Without this, every possible cause collapsed into one
 *  hardcoded generic string in the UI regardless of what actually went wrong — confirmed as a real
 *  gap, not theoretical: it took SSH'ing into a live deployment to find an already-fixed bug that a
 *  visible `reason` would have surfaced immediately from the error message alone. */
export async function exportAvailable(): Promise<{ available: boolean; reason?: string }> {
  if (isNative) return { available: await nativeExportAvailable() };
  try {
    const response = await apiFetch(`${BASE}/export`, { method: "HEAD" });
    const rawReason = response.headers.get("X-Ffmpeg-Unavailable-Reason");
    return {
      available: response.status === 204,
      ...(rawReason ? { reason: decodeURIComponent(rawReason) } : null),
    };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InpaintStarted {
  jobId: string;
}

export interface InpaintProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "extracting" | "masking" | "uploading" | "predicting" | "downloading" | "importing";
  progress: number;
  error?: string;
  /** Present once `status === "done"` — the client lands this directly via `landInpaintedAsset`,
   *  no second round-trip needed. */
  asset?: Asset;
}

/** Starts a "Remove Object" job for one clip — desktop/browser-server-backed only for v1, same as
 *  export (no native branch: this needs the same not-yet-built on-device FFmpeg plugin export does,
 *  plus network access for the cloud model itself). `backgroundPrompt` only matters for the fal.ai
 *  provider (its VOID model requires a description of what should fill the removed region); the
 *  server ignores it harmlessly when Replicate is active. */
export async function startInpaint(projectId: string, clipId: string, rect: SourceRect): Promise<InpaintStarted> {
  if (isNative) throw new ApiRequestError("Remove Object isn't available on this device yet.", 501, "inpaint-unavailable");
  // The cloud (Replicate) path now needs the current session's access token — this LOCAL server has no
  // session of its own; the browser tab relays its own token in, so the local job can forward it on to
  // `inpaint/predict/route.ts` when it actually calls out to vcut.io. See `inpaint/route.ts`'s own doc
  // comment for the full "why" — harmless to always include even when the local ProPainter provider is
  // active (that path never reads it).
  const accessToken = await getAccessToken();
  const response = await apiFetch(`${BASE}/inpaint?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clipId, rect, ...(accessToken ? { accessToken } : null) }),
  });
  return unwrap<InpaintStarted>(response);
}

export async function cancelInpaint(jobId: string): Promise<void> {
  if (isNative) return;
  // A cancel racing the job's own completion is normal, not an error worth surfacing — same
  // reasoning as `cancelExport`.
  await apiFetch(`${BASE}/inpaint?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to a "Remove Object" job's progress. Identical shape to `watchExport` — see its own
 *  comment for why `EventSource` over polling. */
export function watchInpaint(
  jobId: string,
  onUpdate: (progress: InpaintProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) {
    onError("Remove Object isn't available on this device yet.");
    return () => {};
  }
  const source = new EventSource(sseUrl(`${BASE}/inpaint?jobId=${encodeURIComponent(jobId)}`));

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as InpaintProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // See `watchExport`'s own comment on this exact check — `CONNECTING` means EventSource is
    // already retrying a dropped connection on its own (routine for a job that runs any real
    // length of time); only `CLOSED` means the browser gave up for good.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the job. It may still be running.");
    }
  };

  return () => source.close();
}

/** Whether "Remove Object" is usable right now — same "both halves have to check out" shape as
 *  `captionsAvailable()`: this device can do the local half (FFmpeg, and the local model if that's the
 *  active provider) AND, if the active provider is "replicate", the live vcut.io deployment has a
 *  transcription... erm, Replicate key configured (`inpaint/predict/route.ts`'s own HEAD). The local
 *  provider never needs the second check at all. */
export async function inpaintAvailable(): Promise<boolean> {
  if (isNative) return false;
  try {
    const local = await apiFetch(`${BASE}/inpaint`, { method: "HEAD" });
    if (local.status !== 204) return false;
    const status = await getInpaintKeyStatus();
    if (status?.activeProvider === "local") return true;
    const remote = await centralFetch(`/inpaint/predict`, { method: "HEAD" });
    return remote.status === 204;
  } catch {
    return false;
  }
}

/** "local" runs entirely on this machine (self-hosted ProPainter, see `getLocalSetupStatus`/
 *  `startLocalSetup` below) — no key/token concept, unlike the cloud provider. `"fal"` is a legacy
 *  value: a desktop install from before self-supplied keys were retired may still have it saved as its
 *  `activeProvider`, but the server treats it identically to `"replicate"` now (see
 *  `inpaint/predict/route.ts`'s own doc comment) — kept in this union only so that old saved value
 *  still round-trips through `getInpaintKeyStatus()` without a type error, not because it's a real
 *  choice any UI should still offer. */
export type InpaintProvider = "replicate" | "fal" | "local";
type CloudInpaintProvider = "replicate" | "fal";

export interface InpaintKeyStatus {
  activeProvider: InpaintProvider;
  configured: Record<InpaintProvider, boolean>;
}

export async function getInpaintKeyStatus(): Promise<InpaintKeyStatus | null> {
  if (isNative) return null;
  try {
    const response = await apiFetch(`${BASE}/inpaint/settings`);
    return unwrap<InpaintKeyStatus>(response);
  } catch {
    return null;
  }
}

/** Saves a cloud provider's API key. Saving also activates that provider — same "one action does
 *  both" behavior Rixie's own `setApiKey` uses. Never called with `"local"` — it has no key. */
export async function setInpaintApiKey(provider: CloudInpaintProvider, apiKey: string): Promise<void> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await apiFetch(`${BASE}/inpaint/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
  await unwrap<{ ok: true }>(response);
}

/** Switches the active provider without touching any saved key — for a provider that already has
 *  one configured (or, for `"local"`, one that's already set up). */
export async function setActiveInpaintProvider(provider: InpaintProvider): Promise<void> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await apiFetch(`${BASE}/inpaint/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  await unwrap<{ ok: true }>(response);
}

export interface LocalSetupProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "cloning" | "venv" | "installing" | "finalizing";
  progress: number;
  error?: string;
}

/** Whether the local ProPainter runtime (Python venv + cloned repo) is provisioned — the Inspector
 *  calls this to decide between offering "Set up local model" and the normal ready-to-use flow. */
export async function getLocalSetupStatus(): Promise<{ ready: boolean } | null> {
  if (isNative) return null;
  try {
    const response = await apiFetch(`${BASE}/inpaint/local-setup`);
    return unwrap<{ ready: boolean }>(response);
  } catch {
    return null;
  }
}

/** Starts provisioning the local Python runtime — long-running (several minutes, network + disk
 *  heavy), same fire-and-track-via-SSE shape as `startInpaint`/`watchInpaint`. */
export async function startLocalSetup(): Promise<{ jobId: string }> {
  if (isNative) throw new ApiRequestError("Not available on this device yet.", 501, "inpaint-unavailable");
  const response = await apiFetch(`${BASE}/inpaint/local-setup`, { method: "POST" });
  return unwrap<{ jobId: string }>(response);
}

export async function cancelLocalSetup(jobId: string): Promise<void> {
  if (isNative) return;
  await apiFetch(`${BASE}/inpaint/local-setup?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to a local-setup job's progress. Identical shape to `watchInpaint`. */
export function watchLocalSetup(
  jobId: string,
  onUpdate: (progress: LocalSetupProgress) => void,
  onError: (message: string) => void
): () => void {
  if (isNative) {
    onError("Not available on this device yet.");
    return () => {};
  }
  const source = new EventSource(sseUrl(`${BASE}/inpaint/local-setup?jobId=${encodeURIComponent(jobId)}`));

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as LocalSetupProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    // See `watchExport`'s own comment on this exact check — `CONNECTING` means EventSource is
    // already retrying a dropped connection on its own; only `CLOSED` means it gave up for good.
    if (source.readyState === EventSource.CLOSED) {
      onError("Lost contact with the setup job. It may still be running.");
    }
  };

  return () => source.close();
}

// ---------------------------------------------------------------------------
// Auto Captions — same fire-and-track-via-SSE job shape as Remove Object
// (startInpaint/watchInpaint/cancelInpaint/inpaintAvailable above), against
// /api/vcut/captions instead. Runs on Replicate's `openai/whisper` model,
// funded by the SAME saved Replicate token Remove Object uses — there is no
// captions-specific key-status/save pair here at all; callers check/save
// that credential via `getInpaintKeyStatus`/`setInpaintApiKey("replicate", …)`
// above instead (see `_lib/inpaintEnvFile.ts`'s `getReplicateToken` for why
// captions deliberately doesn't route through `getActiveInpaintToken`'s own
// "whichever provider Remove Object currently has active" indirection).
// ---------------------------------------------------------------------------

export interface CaptionsStarted {
  jobId: string;
}

export interface CaptionSegment {
  content: string;
  /** Absolute sequence-timeline seconds — already offset server-side, ready to place directly. */
  start: number;
  end: number;
  /** Real per-word timing, CLIP-RELATIVE (seconds from THIS segment's own `start`) — present only when
   *  the server's transcription provider returned genuine per-word timestamps (currently: Kiri, for
   *  Khmer), absent otherwise. `AddCaptionsCommand` copies this straight onto `Clip.wordTimings` when
   *  the landed animation is `wordHighlight` — see that field's own doc comment. */
  words?: { text: string; start: number; end: number }[];
}

export interface CaptionsProgress {
  status: "running" | "done" | "failed" | "cancelled";
  stage: "extracting-audio" | "transcribing" | "building-captions";
  progress: number;
  error?: string;
  /** Present once `status === "done"` — raw segments, not yet real assets/clips. The caller (Inspector's
   *  Auto Captions section, the toolbar's Auto Captions dialog) hands these to
   *  `useEditorStore.getState().landCaptions`, which is what actually creates the text assets and
   *  places their clips as one undo-able step. */
  captions?: CaptionSegment[];
}

/** Starts an Auto Captions job. `clipIds` present = transcribe just those clips' own on-screen time
 *  ranges — one clip for a single-clip selection, several for a multi-clip one (their audio is
 *  extracted and concatenated back-to-back server-side, skipping whatever gap sits between them on the
 *  timeline, so a run of trimmed pieces reads as one continuous transcript instead of either stopping
 *  at the first piece or picking up unrelated audio from the gaps — see `captions/route.ts`'s own
 *  `runCaptionsJob` doc comment); omitted or empty = transcribe the whole sequence. `language` is a
 *  Whisper language code (e.g. `"en"`, `"km"`) or `"auto"` (the default) to let the model detect it —
 *  see `LANGUAGE_OPTIONS` below for the curated set both Auto Captions entry points offer; the server
 *  accepts any of Whisper's own ~100 codes, this is just what the UI exposes. `wordHighlight` tightens
 *  the server's own caption-chunk size limits (shorter chunks, capped by word count instead of
 *  character count) so the Word Highlight animation's even-distribution-within-the-clip timing
 *  approximation stays perceptible/accurate — pass it when that's the animation the caller is about to
 *  apply. Desktop/browser-server-backed only for v1, same as `startInpaint`. */
/** Runs in two passes now — see `captions/route.ts`'s own doc comment for the full "why two routes"
 *  story. First, a LOCAL call (this device's own server) extracts and concatenates the requested
 *  ranges' audio — this can only run on the machine that actually has the project's real media files.
 *  Then a REMOTE call (`centralFetch`, live vcut.io) starts the actual transcription job on just that
 *  small extracted audio file — the secret key only ever lives there. `watchCaptions` picks the job up
 *  from that second call's `jobId`. Native (mobile) has no local SERVER to run `captions/route.ts`'s own
 *  extraction logic, so it runs the on-device equivalent instead (`nativeExtractCaptionAudio`, via the
 *  same FFmpeg plugin export already depends on) — the remote half below is identical on every
 *  platform, `captions/transcribe/route.ts` is already CORS-enabled for exactly this. `project` (the
 *  live in-memory project, not whatever's last saved to disk) is only actually used on the native path —
 *  kept as a required parameter anyway, same as `startExport`, so a caller can't accidentally pass a
 *  stale one only on some platforms. */
export async function startCaptions(
  projectId: string,
  project: Project,
  clipIds?: string[],
  language?: string,
  wordHighlight?: boolean,
): Promise<CaptionsStarted> {
  const extracted = isNative
    ? await nativeExtractCaptionAudio(projectId, project, clipIds)
    : await unwrap<{ audioBase64: string; ranges: { start: number; end: number }[]; durations: number[] }>(
        await apiFetch(`${BASE}/captions?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(clipIds && clipIds.length > 0 ? { clipIds } : {}),
        })
      );

  const response = await centralFetch(`/captions/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioBase64: extracted.audioBase64,
      ranges: extracted.ranges,
      durations: extracted.durations,
      ...(language ? { language } : null),
      ...(wordHighlight ? { wordHighlight: true } : null),
    }),
  });
  return unwrap<CaptionsStarted>(response);
}

/** Curated subset of Whisper's own ~100 supported language codes — every entry here is a real, valid
 *  code (confirmed against `openai/whisper`'s own `tokenizer.py` `LANGUAGES` dict), just not the full
 *  list: both Auto Captions entry points (`AutoCaptionsDialog`, Inspector's `AutoCaptionsSection`) show
 *  this as a dropdown rather than every language Whisper technically supports, weighted toward this
 *  app's own userbase (Khmer alongside the handful of languages any transcription tool would offer).
 *  `"auto"` (Whisper's own auto-detect) is first and is the default `startCaptions` falls back to. */
export const CAPTION_LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "km", label: "Khmer" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "pt", label: "Portuguese" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
];

export async function cancelCaptions(jobId: string): Promise<void> {
  // A cancel racing the job's own completion is normal, not an error worth surfacing. The job this
  // targets always lives on the REMOTE (transcription) side regardless of platform — see
  // `watchCaptions`'s own comment — so there's no native-vs-not branch here.
  await centralFetch(`/captions/transcribe?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Subscribes to an Auto Captions job's progress — the REMOTE (transcription) job specifically, since
 *  extraction already finished by the time `startCaptions` returned a `jobId` at all. Identical shape
 *  to `watchAiVideo` — see that function's own doc comment for why `centralSseUrl`, not `sseUrl`. Works
 *  unchanged on native: `centralSseUrl` always points at the live vcut.io deployment (CORS-enabled)
 *  regardless of platform, there is no local job here to watch instead. */
export function watchCaptions(jobId: string, onUpdate: (progress: CaptionsProgress) => void, onError: (message: string) => void): () => void {
  const source = new EventSource(centralSseUrl(`${BASE}/captions/transcribe?jobId=${encodeURIComponent(jobId)}`));

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as CaptionsProgress;
      onUpdate(payload);
      if (payload.status !== "running") source.close();
    } catch {
      /* a malformed frame is not worth tearing the stream down over */
    }
  };

  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) {
      onError("Lost contact with the captions job. It may still be running.");
    }
    source.close();
  };

  return () => source.close();
}

/** Whether Auto Captions is usable right now — BOTH halves have to check out: this device can do the
 *  local extraction (FFmpeg present — on native, the same plugin check `exportAvailable()` uses; off
 *  native, `captions/route.ts`'s own HEAD) AND the live vcut.io deployment has a transcription key
 *  configured (`captions/transcribe/route.ts`'s own HEAD, `centralFetch`). */
export async function captionsAvailable(): Promise<boolean> {
  try {
    const [local, remote] = await Promise.all([
      isNative ? nativeExportAvailable() : apiFetch(`${BASE}/captions`, { method: "HEAD" }).then((r) => r.status === 204),
      centralFetch(`/captions/transcribe`, { method: "HEAD" }),
    ]);
    return local && remote.status === 204;
  } catch {
    return false;
  }
}

/** Saves the CURRENT project's structure (aspect ratio, tracks, any text/color-matte clips already
 *  laid out — never real media, see `templates/route.ts`'s own `sanitizeProjectForTemplate` call for
 *  exactly what's kept) as a new reusable template — Pro-only end to end, same as using one to start
 *  a new project (`ProjectsDashboard.tsx`'s own "start from a template" flow calls the project-
 *  creation route directly rather than through this file — see that file's own doc comment on why it
 *  duplicates `apiFetch`/`mediaUrl` instead of importing this module). Hosted-only: there's no local/
 *  desktop "Pro" concept to save a template against, so this isn't given an `isNative` branch the way
 *  LUT/font import are — the button that calls this simply doesn't render outside a hosted, Pro
 *  session in the first place. */
/** `keepAssetIds`: which of `templateSlotCandidates`' own candidates the author chose to keep FIXED
 *  rather than let become a fillable slot — see `SaveAsTemplateDialog.tsx`'s own checklist. */
export async function saveAsTemplate(projectId: string, name: string, keepAssetIds?: string[]): Promise<{ id: string; name: string }> {
  const response = await apiFetch(`${BASE}/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, name, keepAssetIds }),
  });
  return unwrap<{ id: string; name: string }>(response);
}
