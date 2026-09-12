"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Logout, Profile } from "@veasnawt/vicons";
import type { BillingStatus } from "../api/billing.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

/** Same "compute from a rect, clamp to viewport, open below the anchor" shape as `ImportSourceMenu`'s
 *  own `popupPosition` — right-aligned to the anchor (not left, like that one) since this trigger
 *  sits at the FAR right edge of the header, where a left-aligned popup would run off-screen. */
function popupPosition(anchor: DOMRect): { top: number; right: number } {
  return { top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) };
}

/** Replaces what used to be two separate always-visible header buttons ("Account", "Sign out") with
 *  one trigger — confirmed a real UX complaint, not a hypothetical one: those two plain-text buttons
 *  sat directly against the save-status text with no visual separation, reading as one cluttered run
 *  of labels rather than a legible header. One button showing the user's own email, opening this
 *  short menu, matches the "collapse related account actions behind one entry point" pattern most
 *  apps already use for exactly this — VCut just didn't have anywhere to put a SECOND account action
 *  (Account) until this session added it, which is what turned two buttons into a real problem. */
export function UserMenu({
  anchorRef,
  email,
  credits,
  onOpenAccount,
  onSignOut,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  email: string | null;
  /** `null` outside hosted mode, or before the check resolves — see the header's own trigger button
   *  for why the NUMBER lives here (one click deep) rather than back in the always-visible header a
   *  plain readout was already tried and removed from. */
  credits?: BillingStatus | null;
  onOpenAccount: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const anchor = anchorRef.current?.getBoundingClientRect();

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose]);

  if (!anchor) return null;
  const { top, right } = popupPosition(anchor);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("Account menu")}
      style={{ position: "fixed", top, right, width: 200 }}
      className="z-50 overflow-hidden rounded-lg border border-white/10 bg-[#181b22] py-1 shadow-2xl"
    >
      {(email || credits) && (
        <div className="border-b border-white/10 px-3 py-2">
          {email && <p className="truncate text-[11px] text-white/40">{email}</p>}
          {credits && (
            <p className="mt-0.5 text-[11px] text-white/60">
              {t("{plan} · {n} credits left", { plan: credits.plan === "pro" ? t("Pro") : t("Free"), n: credits.creditsRemaining })}
            </p>
          )}
        </div>
      )}
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onOpenAccount();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-white/85 transition hover:bg-white/10"
      >
        <Profile size={16} className="shrink-0 text-white/50" />
        {t("Account")}
      </button>
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onSignOut();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-white/85 transition hover:bg-white/10"
      >
        <Logout size={16} className="shrink-0 text-white/50" />
        {t("Sign out")}
      </button>
    </div>,
    document.body
  );
}
