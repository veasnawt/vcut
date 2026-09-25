"use client";

import { useState } from "react";
import { Close } from "@veasnawt/vicons";
import type { Clip } from "../project/types.ts";
import { TEXT_ANIMATION_TYPE_LABEL, TEXT_ANIMATION_TYPE_OPTIONS, TEXT_INOUT_TYPE_LABEL, TEXT_INOUT_TYPE_OPTIONS } from "../timeline/textAnimation.ts";
import { useTranslation } from "../i18n/useTranslation.ts";
import { TextAnimationPreviewTile } from "./TextAnimationPreviewTile.tsx";
import { TextInOutPreviewTile } from "./TextInOutPreviewTile.tsx";

type InOutValue = Clip["textAnimationIn"] | null | undefined;

/** What a tile under the pointer would apply, for a caller that wants to preview it (the text composer shows it
 *  on the live text). `null` for a side means the None tile; the whole callback gets `null` on mouse-leave. */
export interface AnimationHoverPreview {
  animation?: Clip["textAnimation"] | null;
  animationIn?: Clip["textAnimationIn"] | null;
  animationOut?: Clip["textAnimationOut"] | null;
}
type PickerTab = "in" | "out" | "loop";

const TAB_LABEL: Record<PickerTab, string> = { in: "In", out: "Out", loop: "Loop" };

function NoneTile({ active, onClick, label, onHover }: { active: boolean; onClick: () => void; label: string; onHover?: (hovering: boolean) => void }) {
  return (
    <button onClick={onClick} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${active ? "bg-sky-500/20" : ""}`}>
      <div className="flex items-center justify-center rounded border border-white/10 bg-black/40 text-white/30" style={{ width: 84, height: 48 }}>
        <Close size={14} />
      </div>
      <span className="text-[10px] text-white/70">{label}</span>
    </button>
  );
}

/** The animation picker for text — a None tile plus one animated tile per option. Always offers the looping
 *  animations ("Loop": bounce, pulse, wiggle, float, shake, heartbeat, typewriter, word highlight). Callers
 *  that also pass `onPickIn` / `onPickOut` get an In / Out / Loop tab bar on top — entrance and exit
 *  animations that play over the first / last part of the clip. Callers that don't (Auto Captions, Script
 *  import, multi-select) keep the plain loop grid exactly as before.
 *
 *  Scoped to TYPE only: `speed`/`highlightColor`/duration fine-tuning stays Inspector-only, single-clip —
 *  bulk-applying a whole selection to a specific speed doesn't have the same obvious "one right answer" a
 *  type choice does. `current*` picks which tile (if any) reads as active; pass `undefined` when the answer
 *  would be ambiguous (e.g. a multi-select whose clips don't all share one animation) so nothing is
 *  highlighted rather than showing a misleading one. */
export function TextAnimationPickerGrid({
  current,
  onPick,
  currentIn,
  onPickIn,
  currentOut,
  onPickOut,
  onHover,
}: {
  current: Clip["textAnimation"] | null | undefined;
  onPick: (next: Clip["textAnimation"] | null) => void;
  currentIn?: InOutValue;
  onPickIn?: (next: Clip["textAnimationIn"] | null) => void;
  currentOut?: InOutValue;
  onPickOut?: (next: Clip["textAnimationOut"] | null) => void;
  /** Fired as the pointer enters / leaves a tile (`null` on leave) — see `AnimationHoverPreview`. */
  onHover?: (preview: AnimationHoverPreview | null) => void;
}) {
  const t = useTranslation();
  const tabs: PickerTab[] = onPickIn && onPickOut ? ["in", "out", "loop"] : ["loop"];
  const [tab, setTab] = useState<PickerTab>(tabs[0]);
  const activeTab = tabs.includes(tab) ? tab : tabs[0];

  function inOutGrid(mode: "in" | "out") {
    const value = mode === "in" ? currentIn : currentOut;
    const pick = mode === "in" ? onPickIn! : onPickOut!;
    return (
      <div className="grid grid-cols-3 gap-1.5">
        <NoneTile active={!value} onClick={() => pick(null)} label={t("None")} onHover={(on) => onHover?.(on ? (mode === "in" ? { animationIn: null } : { animationOut: null }) : null)} />
        {TEXT_INOUT_TYPE_OPTIONS.map((type) => (
          <button
            key={type}
            onMouseEnter={() => onHover?.(mode === "in" ? { animationIn: { type } } : { animationOut: { type } })}
            onMouseLeave={() => onHover?.(null)}
            // Switching TYPE keeps a duration already set on the current animation.
            onClick={() => pick({ type, ...(value?.duration ? { duration: value.duration } : null) })}
            className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${value?.type === type ? "bg-sky-500/20" : ""}`}
          >
            <TextInOutPreviewTile type={type} mode={mode} />
            <span className="text-[10px] text-white/70">{t(TEXT_INOUT_TYPE_LABEL[type])}</span>
          </button>
        ))}
      </div>
    );
  }

  const loopGrid = (
    <div className="grid grid-cols-3 gap-1.5">
      <NoneTile active={!current} onClick={() => onPick(null)} label={t("None")} onHover={(on) => onHover?.(on ? { animation: null } : null)} />
      {TEXT_ANIMATION_TYPE_OPTIONS.map((type) => (
        <button
          key={type}
          onMouseEnter={() => onHover?.({ animation: { type } })}
          onMouseLeave={() => onHover?.(null)}
          onClick={() =>
            // Switching TYPE keeps whatever `speed`/`highlightColor` was already set on `current` —
            // same reasoning as Inspector's original single-clip version of this grid.
            onPick({
              type,
              ...(current?.highlightColor ? { highlightColor: current.highlightColor } : null),
              ...(current?.speed ? { speed: current.speed } : null),
            })
          }
          className={`flex flex-col items-center gap-1 rounded p-1 transition hover:bg-white/10 ${current?.type === type ? "bg-sky-500/20" : ""}`}
        >
          <TextAnimationPreviewTile type={type} />
          <span className="text-[10px] text-white/70">{t(TEXT_ANIMATION_TYPE_LABEL[type])}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div>
      {tabs.length > 1 && (
        <div role="tablist" className="mb-2 flex gap-1">
          {tabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
              className={`flex-1 rounded-md py-1 text-[11px] transition ${activeTab === id ? "bg-sky-500/20 text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}
            >
              {t(TAB_LABEL[id])}
              {(id === "in" ? currentIn : id === "out" ? currentOut : current) ? " •" : ""}
            </button>
          ))}
        </div>
      )}
      {activeTab === "in" ? inOutGrid("in") : activeTab === "out" ? inOutGrid("out") : loopGrid}
    </div>
  );
}
