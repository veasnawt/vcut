"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "@veasnawt/vicons";
import { AI_EDIT_CATEGORIES, templatesInCategory, type AiEditCategoryId, type AiEditTemplate } from "../project/aiEdit.ts";
import { useTranslation } from "../i18n/useTranslation.ts";

/** One template card: the user's own picture with the template's look laid over it (a CSS filter and a tint), so the
 *  thumbnail shows roughly what the style does to THEIR media — a plain gradient when there is no picture to show. */
function TemplateCard({
  template,
  imageUrl,
  selected,
  wide,
  onPick,
}: {
  template: AiEditTemplate;
  imageUrl: string | null;
  selected: boolean;
  /** Fills its grid cell instead of keeping a fixed width in the scrolling strip. */
  wide: boolean;
  onPick: () => void;
}) {
  const t = useTranslation();
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={`group flex shrink-0 snap-start flex-col overflow-hidden rounded-xl border bg-white/[0.03] text-left transition active:scale-[0.98] ${
        wide ? "w-full" : "w-[9.5rem] sm:w-40"
      } ${selected ? "border-sky-400 ring-1 ring-sky-400/70" : "border-white/10 hover:border-white/25"}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#0b0d13]">
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" style={{ filter: template.look.filter }} />
        )}
        <div className="absolute inset-0" style={{ background: template.look.tint, mixBlendMode: imageUrl ? "soft-light" : "normal" }} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
        {selected && <span className="absolute right-1.5 top-1.5 rounded-full bg-sky-500 px-1.5 py-0.5 text-[9px] font-semibold text-white">{t("Selected")}</span>}
      </div>
      <div className="space-y-0.5 px-2.5 py-2">
        <div className="truncate text-xs font-semibold text-white">{t(template.title)}</div>
        <div className="line-clamp-2 min-h-[2.1em] text-[10.5px] leading-snug text-white/50">{t(template.description)}</div>
      </div>
    </button>
  );
}

/** Category chips and the template cards below them: a swipeable strip by default, a full grid once expanded. */
export function AiEditTemplateGallery({
  imageUrl,
  selectedId,
  onPick,
}: {
  imageUrl: string | null;
  selectedId: string | null;
  onPick: (template: AiEditTemplate) => void;
}) {
  const t = useTranslation();
  const [category, setCategory] = useState<AiEditCategoryId>("for-you");
  const [expanded, setExpanded] = useState(false);
  const templates = templatesInCategory(category);

  return (
    <section className="space-y-2.5" aria-label={t("Templates")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-white/80">{t("Templates")}</h3>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-sky-300 hover:bg-white/5"
        >
          {expanded ? t("Show less") : t("See all")}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist" aria-label={t("Template categories")}>
        {AI_EDIT_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={`min-h-9 shrink-0 rounded-full border px-3.5 text-xs font-medium transition ${
              category === c.id ? "border-sky-400 bg-sky-500/20 text-white" : "border-white/10 bg-white/[0.04] text-white/65 hover:text-white"
            }`}
          >
            {t(c.label)}
          </button>
        ))}
      </div>

      {expanded ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} imageUrl={imageUrl} selected={selectedId === template.id} wide onPick={() => onPick(template)} />
          ))}
        </div>
      ) : (
        <div className="scrollbar-none -mx-4 flex snap-x snap-proximity gap-2.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} imageUrl={imageUrl} selected={selectedId === template.id} wide={false} onPick={() => onPick(template)} />
          ))}
        </div>
      )}
    </section>
  );
}
