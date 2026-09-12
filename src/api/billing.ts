import { getAccessToken } from "@veasnawt/auth";
import { unwrap } from "./client.ts";

/** Unlike everything else in `client.ts` (relative paths — each platform only ever calls its OWN
 *  server: the hosted deploy calls itself, desktop calls its own bundled loopback server), billing
 *  has exactly ONE real backend regardless of platform — VCut pays for Stripe centrally, so there is
 *  no "desktop's own Stripe integration" to build. Desktop and mobile call OUT to the single live
 *  hosted deployment for these four endpoints specifically; the web app itself also works fine
 *  hitting this same absolute URL (a same-origin absolute URL behaves identically to a relative one).
 *  See `studios/vcut/app/api/vcut/_lib/localOnly.ts`'s `hostedOnlyRoute`/`withCors` for the server
 *  side of why this is safe to call cross-origin (bearer-token auth, no cookie to steal). */
const BILLING_ORIGIN = "https://vcut.io";
const BASE = `${BILLING_ORIGIN}/api/vcut/billing`;

/** Always attaches the current Supabase session's access token, on every platform — unlike `client.ts`'s
 *  own `apiFetch`, which only does this when the CURRENT app is itself the hosted deployment. Desktop
 *  and mobile are never "hosted" but still need to authenticate to this one shared backend, so that
 *  condition doesn't apply here; a signed-out caller (no token at all) still sends the request, and
 *  the server's own `requireSessionUser` is what turns that into a real 401 the UI can react to. */
async function billingFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export type Plan = "free" | "pro";

export interface BillingStatus {
  plan: Plan;
  currentPeriodEnd: string | null;
  /** How many credits (Auto Captions, Remove Object, and later generation features all spend from
   *  this same balance — see `studios/vcut/app/api/vcut/_lib/credits.ts`) this user currently has.
   *  Meaningful for both plans: free users get a small monthly taste, Pro a much larger one. */
  creditsRemaining: number;
  creditsResetAt: string;
}

/** Real per-operation credit costs — MUST exactly match the server's own constants (each named in its
 *  own comment below) or this becomes a UI that lies about what an action actually costs. Duplicated
 *  here rather than fetched: these are fixed pricing facts, not per-user data, the same "change both
 *  together" tradeoff `studios/vcut/app/api/vcut/_lib/credits.ts`'s own doc comment already accepts
 *  for `spend_credits`'s Postgres-function duplicate of `FREE_CREDITS_PER_MONTH`/
 *  `PRO_CREDITS_PER_MONTH`. Added because the cost of every credit-gated action was previously
 *  invisible until either the balance visibly dropped or hit zero — asked for directly, so a user can
 *  see what they're about to spend before spending it, not just be told afterward. */
export const AI_IMAGE_CREDITS: Record<"flare" | "sunburst" | "nano-banana-2", number> = {
  // Matches ai-image/route.ts's own MODELS[...].credits exactly.
  flare: 4,
  sunburst: 16,
  "nano-banana-2": 21,
};
/** Matches ai-video/route.ts's own AI_VIDEO_CREDITS_PER_GENERATION. */
export const AI_VIDEO_CREDITS_PER_GENERATION = 154;
/** Matches inpaint/route.ts's own REMOVE_OBJECT_CREDITS_PER_SECOND — a per-second rate, not a flat
 *  cost (see that constant's own comment: billed by however many seconds of the clip are processed,
 *  with a one-second minimum). */
export const REMOVE_OBJECT_CREDITS_PER_SECOND = 16;
/** Matches captions/route.ts's own CAPTIONS_CREDITS_PER_MINUTE — a per-minute rate with a one-minute
 *  minimum, same shape as Remove Object's own per-second rate above. */
export const CAPTIONS_CREDITS_PER_MINUTE = 4;

/** Answers "is the signed-in user currently Pro, and how many credits do they have left?" — the one
 *  call every platform makes to decide whether to show a premium feature, an "upgrade to Pro"
 *  prompt, or a "not enough credits, wait for your refill" message. A signed-out user (no Supabase
 *  session at all, e.g. desktop/mobile before the new sign-in flow exists) gets a 401 from the
 *  server; that's surfaced as the free defaults here rather than a thrown error, since a caller
 *  deciding whether to gate a feature treats "not signed in" the same as "signed in, on the free
 *  plan, no credits used yet." */
export async function getBillingStatus(): Promise<BillingStatus> {
  try {
    return await unwrap<BillingStatus>(await billingFetch("/status"));
  } catch {
    return { plan: "free", currentPeriodEnd: null, creditsRemaining: 0, creditsResetAt: new Date().toISOString() };
  }
}

/** Starts a Stripe Checkout session and returns its URL — the caller navigates the browser there
 *  (`window.location.href = url`) rather than this function redirecting itself, since what "navigate"
 *  means differs by platform (a plain browser location change on web, `Browser.open()` on native). */
export async function startCheckout(): Promise<string> {
  const { url } = await unwrap<{ url: string }>(await billingFetch("/checkout", { method: "POST" }));
  return url;
}

/** Opens Stripe's Customer Portal — same "returns a URL, caller navigates" shape as `startCheckout`.
 *  Throws `ApiRequestError` with code `"no-stripe-customer"` for a user who's never subscribed; see
 *  `portal/route.ts`'s own doc comment for why that's a 400 rather than silently creating one. */
export async function openBillingPortal(): Promise<string> {
  const { url } = await unwrap<{ url: string }>(await billingFetch("/portal", { method: "POST" }));
  return url;
}
