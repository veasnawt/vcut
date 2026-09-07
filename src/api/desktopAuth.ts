declare global {
  interface Window {
    /** Only defined inside the packaged/dev Electron shell (`apps/vcut-desktop`), wired up by its own
     *  `preload.ts` — absent entirely in a plain browser tab or the native mobile shell, exactly how
     *  the functions below pick whether desktop sign-in is even offered. Same "feature-detected via
     *  presence, not a platform branch" convention `crashLog.ts`'s `veasnaCrashReporter` already uses. */
    veasnaAuth?: {
      openSignIn: () => Promise<void>;
      onCallback: (callback: (tokens: { accessToken: string; refreshToken: string }) => void) => () => void;
    };
  }
}

/** Whether this build can offer a desktop sign-in button at all — `VCutApp.tsx`'s header checks this
 *  before rendering one, the same way it already checks `useSupabaseSession`'s `user` before rendering
 *  Sign out. `false` for the web build (signing in there is just the existing `/login` page — no
 *  system-browser round trip needed) and for the native mobile shell (see that platform's own
 *  in-app-OTP sign-in instead of this flow). */
export function isDesktopSignInAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.veasnaAuth);
}

/** Opens `https://vcut.io/login?desktop=1` in the user's own OS browser — see `apps/vcut-desktop/src/
 *  main.ts`'s own doc comment for the full round trip this kicks off. A no-op if `veasnaAuth` isn't
 *  present (checked by `isDesktopSignInAvailable` before this is ever wired to a button, but safe to
 *  call unconditionally regardless). */
export function openDesktopSignIn(): void {
  void window.veasnaAuth?.openSignIn();
}

/** Subscribes to the tokens `main.ts` extracts once the sign-in round trip redirects back to
 *  `vcut://auth-callback` — `VCutApp.tsx` is the one caller, handing them straight to Supabase's own
 *  `setSession` to turn them into a real signed-in session, exactly as if the magic-link/OAuth flow
 *  had redirected back to this same window itself (which, on desktop, it never can — the callback
 *  lands in the OS browser that opened it, not this Electron window). Returns an unsubscribe function,
 *  or a no-op if `veasnaAuth` isn't present, so the caller's cleanup doesn't need its own feature
 *  check. */
export function subscribeToDesktopAuthCallback(callback: (tokens: { accessToken: string; refreshToken: string }) => void): () => void {
  return window.veasnaAuth?.onCallback(callback) ?? (() => {});
}
