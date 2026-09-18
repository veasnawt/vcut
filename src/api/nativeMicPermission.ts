import { Capacitor, registerPlugin } from "@capacitor/core";

export type MicPermissionState = "granted" | "blocked" | "prompt";

/** The Android/iOS apps' own `MicPermissionPlugin` (Kotlin/Swift) — absent on the web, which is exactly
 *  how `isNativeMicPermissionAvailable` decides whether any of this applies at all. Exists to fill a gap
 *  neither platform's OWN Capacitor internals cover: once the OS has permanently denied the microphone,
 *  neither platform ever shows that permission dialog again, and plain `getUserMedia` just keeps
 *  rejecting with `NotAllowedError` forever with no way to recover in-app. See `useVoiceRecording.ts`'s
 *  own use of this for the full flow. */
interface MicPermissionPlugin {
  /** A best-effort HINT only, safe to call anytime (e.g. on mount, to decide whether to show the
   *  "blocked" UI before the user has tapped anything this session) — NOT authoritative. Neither
   *  platform can fully distinguish "never asked, ever" from "permanently denied" without having made a
   *  REAL request through this exact plugin at least once; before that, this can under-report "blocked"
   *  as "prompt". Always call `request()`, not this, right before actually trying to record. */
  check(): Promise<{ state: MicPermissionState }>;
  /** The AUTHORITATIVE check — performs a real permission request (or reconfirms an already-decided one)
   *  through the OS itself, so its result reflects true history regardless of what happened before this
   *  plugin ever ran (including denials from `getUserMedia`'s own separate native permission path). Call
   *  this, and only proceed to `getUserMedia` on `"granted"` — the whole point is skipping a `getUserMedia`
   *  call that can only ever reject once this already knows the answer. */
  request(): Promise<{ state: MicPermissionState }>;
  /** Opens this app's own page in the system Settings app — `getUserMedia` itself can never trigger the
   *  OS permission dialog again once blocked, so this is the only way back. */
  openSettings(): Promise<void>;
}

const MicPermission = registerPlugin<MicPermissionPlugin>("MicPermission");

export function isNativeMicPermissionAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("MicPermission");
}

/** `"granted"` on the web (or if the native call itself fails) — see `MicPermissionPlugin.check`'s own
 *  doc comment for why this is a hint, not a decision. */
export async function checkMicPermissionState(): Promise<MicPermissionState> {
  if (!isNativeMicPermissionAvailable()) return "granted";
  try {
    return (await MicPermission.check()).state;
  } catch {
    return "prompt";
  }
}

/** See `MicPermissionPlugin.request`'s own doc comment — this is the one that actually decides whether
 *  `getUserMedia` is even worth calling. `"granted"` on the web, where there's no separate gate at all. */
export async function requestMicPermission(): Promise<MicPermissionState> {
  if (!isNativeMicPermissionAvailable()) return "granted";
  try {
    return (await MicPermission.request()).state;
  } catch {
    return "prompt";
  }
}

export function openMicPermissionSettings(): Promise<void> {
  return MicPermission.openSettings();
}
