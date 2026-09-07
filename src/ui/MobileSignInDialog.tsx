"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@veasnawt/auth";
import { useTranslation } from "../i18n/useTranslation.ts";

type Phase = "email" | "code";

/** Mobile's own sign-in flow — deliberately NOT desktop's system-browser-plus-custom-protocol dance
 *  (see `desktopAuth.ts`'s doc comment for why that exists at all): Capacitor's WebView can run
 *  Supabase's JS client directly, so there's no unstable local port or OAuth-redirect-registration
 *  problem to route around here. A numeric emailed code (not a magic LINK) avoids needing any
 *  deep-link/custom-URL-scheme plumbing for a link to hand a session back to this specific app — the
 *  code is just typed in by hand. Requires the Supabase project's own Auth email template to send a
 *  numeric OTP rather than a link (a dashboard setting, not code — `signInWithOtp` itself is the same
 *  call either way; which template fires is configured server-side in Supabase, not chosen here).
 *  Once `verifyOtp` succeeds, `useSupabaseSession`'s own `onAuthStateChange` subscription picks up the
 *  new session automatically — this dialog needs no callback of its own beyond closing itself. */
export function MobileSignInDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    const supabase = getSupabaseBrowserClient();
    const trimmed = email.trim();
    if (!supabase || !trimmed) return;
    setBusy(true);
    setError(null);
    const { error: sendError } = await supabase.auth.signInWithOtp({ email: trimmed });
    setBusy(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setPhase("code");
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

        {phase === "email" ? (
          <>
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
            {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
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
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-white/60">
              {t("Enter the code we sent to {email}", { email })}
            </p>
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
            {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
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
