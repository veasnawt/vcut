import { getAccessToken } from "@veasnawt/auth";
import { unwrap } from "./client.ts";

/** Templates only ever live on the one live vcut.io deployment (see `studios/vcut/app/api/vcut/_lib/
 *  localOnly.ts`'s own doc comment on `hostedOnlyRoute` — there's no local/desktop concept of a saved
 *  template). This module is native mobile's own counterpart of `studios/vcut/app/_shared/
 *  hostedClient.ts`'s `centralAuthFetch`/`templatePreviewUrl`/etc — same "always attach the token, go
 *  straight to the live deployment" shape as `billing.ts`'s `billingFetch`, just simpler here since
 *  mobile is ALWAYS `!HOSTED` (no same-origin case to special-case around, unlike the web host's own
 *  version, which is either the hosted deployment itself or isn't). */
const CENTRAL_ORIGIN = "https://vcut.io";
const BASE = `${CENTRAL_ORIGIN}/api/vcut/templates`;

async function centralFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

/** One row from `GET /api/vcut/templates(/discover)` — same shape `hostedClient.ts`'s own `TemplateRow`
 *  describes (duplicated, not imported: that file is part of the Next.js web host, this is part of the
 *  shared editor package consumed by desktop/mobile — see that file's own top doc comment on why the
 *  two stay independent). */
export interface TemplateRow {
  id: string;
  name: string;
  updatedAt: string;
  isPublic: boolean;
  ownerId: string;
  /** See `hostedClient.ts`'s own `TemplateRow.aiCredits`. */
  aiCredits?: number;
  creatorDisplayName?: string | null;
  likeCount?: number;
  commentCount?: number;
  viewerHasLiked?: boolean;
}

/** Every OTHER user's published template — Free-browsable by design (`discover/route.ts`'s own doc
 *  comment), but still requires SOME signed-in session (`hostedOnlyRoute`), so an unauthenticated caller
 *  gets a real 401 here, not a silently-empty list. */
export async function listDiscoverTemplates(): Promise<TemplateRow[]> {
  const { templates } = await unwrap<{ templates: TemplateRow[] }>(await centralFetch("/discover"));
  return templates;
}

/** Your own saved templates — Pro-gated server-side (`requirePro`); a Free account's call comes back
 *  402 `pro-required`, which callers show as an invitation rather than an error (same as the web host's
 *  own Templates tab). Unreachable from a native/mobile project in practice today (`saveAsTemplate`'s
 *  own doc comment: that button only renders in a hosted, Pro session — a device-local project has no
 *  server-side file for the hosted renderer to build a preview from) — this exists so a template saved
 *  from the WEB app still shows up here if that same account opens the mobile app. */
export async function listMyTemplates(): Promise<TemplateRow[]> {
  const { templates } = await unwrap<{ templates: TemplateRow[] }>(await centralFetch(""));
  return templates;
}

function centralAssetUrl(path: string): string {
  return `${BASE}${path}`;
}

export function templatePreviewUrl(templateId: string): string {
  return centralAssetUrl(`/${encodeURIComponent(templateId)}/preview`);
}

export function templatePosterUrl(templateId: string): string {
  return centralAssetUrl(`/${encodeURIComponent(templateId)}/poster`);
}
