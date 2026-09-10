"use client";

/** Small segmented tab bar — introduced specifically to split Auto Captions' Font/Style/Animation
 *  pickers apart (see `AutoCaptionsDialog.tsx`/`Inspector.tsx`'s own `AutoCaptionsSection`): each grid
 *  stacked in one scrollable column was already tight before Font joined them, and Font alone can run
 *  up to ~25 tiles for Khmer — genuinely reusable if another multi-picker dialog needs the same split,
 *  not currently used anywhere else. */
export function PickerTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-2 flex gap-0.5 rounded-lg bg-white/5 p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 rounded-md py-1 text-[11px] font-medium transition ${
            active === tab.id ? "bg-sky-500 text-white" : "text-white/50 hover:bg-white/5 hover:text-white/80"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
