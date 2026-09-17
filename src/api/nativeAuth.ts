import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** The Android app's own `AuthCallbackPlugin.kt` — absent on iOS and the web, which is exactly how
 *  `isNativeBrowserSignInAvailable` decides whether to offer the browser round trip at all. */
interface AuthCallbackPlugin {
  openUrl(options: { url: string }): Promise<void>;
  addListener(eventName: "authCallback", listener: (event: { url: string }) => void): Promise<PluginListenerHandle>;
}

const AuthCallback = registerPlugin<AuthCallbackPlugin>("AuthCallback");

/** vcut.io's login page in its app-handoff mode: once signed in there, it sends the session back
 *  through a `vcut://auth-callback` link instead of opening the web editor. Also where an emailed
 *  sign-in link should land, so tapping one in the email opens the app signed in too. */
export const NATIVE_SIGN_IN_URL = "https://vcut.io/login?desktop=1";

/** Whether this build can sign in through the phone's browser — the Android app, where Google sign-in
 *  can't run inside the app itself (Google blocks sign-in from embedded WebViews). The round trip is
 *  the same one VCut Desktop uses (`desktopAuth.ts`): vcut.io's own login page, then a
 *  `vcut://auth-callback` link back into the app. */
export function isNativeBrowserSignInAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("AuthCallback");
}

/** Opens vcut.io's login page in the phone's browser — `provider: "google"` starts Google sign-in there
 *  straight away instead of showing the page's own choices first. */
export function openNativeBrowserSignIn(provider?: "google"): Promise<void> {
  return AuthCallback.openUrl({ url: provider ? `${NATIVE_SIGN_IN_URL}&provider=${provider}` : NATIVE_SIGN_IN_URL });
}

/** The tokens in a `vcut://auth-callback#access_token=...&refresh_token=...` link, or `null` for
 *  anything else. */
export function parseAuthCallbackUrl(url: string): { accessToken: string; refreshToken: string } | null {
  if (!url.startsWith("vcut://auth-callback")) return null;
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

/** Subscribes to the sign-in link arriving back in the app — including one that launched it, which
 *  the plugin holds until this subscribes. Returns an unsubscribe function (a no-op where the plugin
 *  doesn't exist). */
export function subscribeToNativeAuthCallback(callback: (tokens: { accessToken: string; refreshToken: string }) => void): () => void {
  if (!isNativeBrowserSignInAvailable()) return () => {};
  let handle: PluginListenerHandle | null = null;
  let cancelled = false;
  void AuthCallback.addListener("authCallback", ({ url }) => {
    const tokens = parseAuthCallbackUrl(url);
    if (tokens) callback(tokens);
  }).then((h) => {
    if (cancelled) void h.remove();
    else handle = h;
  });
  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
