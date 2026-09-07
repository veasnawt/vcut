import { useEffect, useState } from "react";
import { HOSTED } from "../api/client.ts";
import { getBillingStatus, type BillingStatus } from "../api/billing.ts";

/** Shared by `AutoCaptionsDialog.tsx` and Inspector's `AutoCaptionsSection`/`RemoveObjectSection` —
 *  the three places re-enabling Captions/Remove Object in hosted mode (see `_lib/credits.ts`) needed
 *  the exact same new data, just rendered into three differently-shaped UIs. `hosted` is `false` for
 *  desktop/local dev (and mobile, until it gets its own credit-gated features) — those never call
 *  `getBillingStatus()` at all, since credits are a hosted-only concept and there's nothing signed-in
 *  to check anyway. `credits` stays `null` while the check is in flight; callers already have an
 *  identical "Checking…" state for `available`/`status` to fold this into.
 *
 *  This is advisory only, not enforcement — the real check happens server-side, atomically, at the
 *  moment a job actually starts (`hostedCreditGatedRoute`'s `spend()`). A caller showing "Generate"
 *  when this hook says credits are available, only to get a 402 back anyway (a concurrent request
 *  from another tab spent the last one first), is a real but rare and harmless race — the existing
 *  `error` state every one of these three UIs already has is what surfaces that. */
export function useHostedCreditsGate(): { hosted: boolean; credits: BillingStatus | null } {
  const [credits, setCredits] = useState<BillingStatus | null>(null);

  useEffect(() => {
    if (HOSTED) void getBillingStatus().then(setCredits);
  }, []);

  return { hosted: HOSTED, credits };
}
