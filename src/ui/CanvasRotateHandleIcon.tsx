import { Refresh } from "@veasnawt/vicons";

/** Visible rotation affordance shared by text and visual clip canvas handles. */
export function CanvasRotateHandleIcon() {
  return (
    <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-white/80 bg-[#162331] text-white shadow-md">
      <Refresh size={14} strokeWidth={2.2} />
    </span>
  );
}
