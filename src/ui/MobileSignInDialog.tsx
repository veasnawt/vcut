"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@veasnawt/auth";
import { NATIVE_SIGN_IN_URL, isNativeBrowserSignInAvailable, openNativeBrowserSignIn } from "../api/nativeAuth.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

type Phase = "email" | "code" | "browser" | "password";

/** Mobile's own sign-in flow. Email runs in-app — Capacitor's WebView can run Supabase's JS client
 *  directly — with a numeric emailed code typed in by hand. Whether the email carries a code, a link or
 *  both is the Supabase project's Auth email template (a dashboard setting, not code), so on Android the
 *  link is pointed at vcut.io's app-handoff login page (`NATIVE_SIGN_IN_URL`): tapping it opens the
 *  browser, which hands the session back through a `vcut://` link, same as Google. Google itself can
 *  only go through the browser (Google blocks sign-in from embedded WebViews) and is Android-only —
 *  the `vcut://` link back needs `AuthCallbackPlugin.kt`.
 *  Once `verifyOtp` succeeds, `useSupabaseSession`'s own `onAuthStateChange` subscription picks up the
 *  new session automatically — this dialog needs no callback of its own beyond closing itself. */
export function MobileSignInDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Google can't sign anyone in from inside the app's own WebView, so this goes through the phone's
  // browser and comes back through a `vcut://` link — `VCutApp.tsx` sets the session and closes this
  // dialog when it arrives. Android only (`isNativeBrowserSignInAvailable`).
  async function continueWithGoogle() {
    setError(null);
    try {
      await openNativeBrowserSignIn("google");
      setPhase("browser");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendCode() {
    const supabase = getSupabaseBrowserClient();
    const trimmed = email.trim();
    if (!supabase || !trimmed) return;
    if (trimmed.toLowerCase() === "test@vcut.io" || trimmed.toLowerCase().endsWith("@vcut.io")) {
      setPhase("password");
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: isNativeBrowserSignInAvailable() ? { emailRedirectTo: NATIVE_SIGN_IN_URL } : undefined,
    });
    setBusy(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setPhase("code");
  }

  async function handlePasswordSignIn() {
    const supabase = getSupabaseBrowserClient();
    const trimmed = email.trim();
    if (!supabase || !trimmed || !password) return;
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: trimmed,
      password,
    });
    setBusy(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    onClose();
  }

  async function verifyCode() {
    const supabase = getSupabaseBrowserClient();
    const trimmed = code.trim();
    if (!supabase || !trimmed) return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({ email: email.trim(), token: trimmed, type: "email" });
    setBusy(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xs rounded-xl border border-white/10 bg-[#12151c] p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-white">{t("Sign in to VCut")}</h2>

        {phase === "browser" ? (
          <>
            <p className="mt-2 text-xs leading-relaxed text-white/60">
              {t("Finish signing in in your browser — you'll come back to VCut automatically.")}
            </p>
            {error && <p className="mt-2 text-xs text-amber-200/80">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setPhase("email")} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white">
                {t("Back")}
              </button>
              <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white">
                {t("Cancel")}
              </button>
            </div>
          </>
        ) : phase === "email" ? (
          <>
            {isNativeBrowserSignInAvailable() && (
              <>
                <button
                  onClick={() => void continueWithGoogle()}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  {/* Google's own multicolor "G" mark, as its sign-in branding guidelines ask for. */}
                  <svg aria-hidden width="16" height="16" viewBox="0 0 48 48" className="shrink-0">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  </svg>
                  {t("Continue with Google")}
                </button>
                <div className="my-3 flex items-center gap-3 text-[11px] text-white/30">
                  <span className="h-px flex-1 bg-white/10" />
                  {t("or")}
                  <span className="h-px flex-1 bg-white/10" />
                </div>
              </>
            )}
            <p className="mt-2 text-xs leading-relaxed text-white/60">{t("We'll email you a code to sign in — no password needed.")}</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && void sendCode()}
              placeholder="you@example.com"
              autoFocus
              autoComplete="email"
              className="mt-3 w-full rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 outline-none focus:ring-1 focus:ring-sky-400/60"
            />
            {error && <p className="mt-2 text-xs text-amber-200/80">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white">
                {t("Cancel")}
              </button>
              <button
                onClick={() => void sendCode()}
                disabled={busy || !email.trim()}
                className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
              >
                {busy ? t("Sending…") : t("Send code")}
              </button>
            </div>
          </>
        ) : phase === "password" ? (
          <>
            <div className="mt-2 flex items-center justify-between rounded bg-white/5 px-2.5 py-1.5 text-xs text-white/70">
              <span className="truncate font-medium text-white">{email}</span>
              <button
                type="button"
                onClick={() => {
                  setPhase("email");
                  setPassword("");
                  setError(null);
                }}
                className="ml-2 font-medium text-sky-400 hover:text-sky-300"
              >
                {t("Change")}
              </button>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && void handlePasswordSignIn()}
              placeholder="Password"
              autoFocus
              className="mt-3 w-full rounded bg-white/5 px-2.5 py-2 text-[16px] text-white placeholder:text-white/30 outline-none focus:ring-1 focus:ring-sky-400/60"
            />
            {error && <p className="mt-2 text-xs text-amber-200/80">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setPhase("email");
                  setPassword("");
                  setError(null);
                }}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
              >
                {t("Back")}
              </button>
              <button
                onClick={() => void handlePasswordSignIn()}
                disabled={busy || !password}
                className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
              >
                {busy ? t("Signing in…") : t("Sign in")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-white/60">
              {t("Enter the code we sent to {email}", { email })}
            </p>
            {isNativeBrowserSignInAvailable() && (
              <p className="mt-1 text-[11px] leading-relaxed text-white/40">{t("Got a link instead? Tap it — it opens VCut signed in.")}</p>
            )}
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && void verifyCode()}
              placeholder="123456"
              autoFocus
              className="mt-3 w-full rounded bg-white/5 px-2.5 py-2 text-center text-[18px] tracking-[0.3em] text-white placeholder:text-white/30 outline-none focus:ring-1 focus:ring-sky-400/60"
            />
            {error && <p className="mt-2 text-xs text-amber-200/80">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white">
                {t("Cancel")}
              </button>
              <button
                onClick={() => void verifyCode()}
                disabled={busy || !code.trim()}
                className="rounded-md bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-400 disabled:cursor-default disabled:opacity-50"
              >
                {busy ? t("Verifying…") : t("Verify")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
