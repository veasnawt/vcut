"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "@veasnawt/vicons";
import { useTranslation } from "../i18n/useTranslation.ts";
import { EditableProjectTitle } from "./EditableProjectTitle.tsx";

/** The header both guided template screens (`TemplateFillScreen`, `TemplatePreviewScreen`) share: the
 *  project's own renameable title with a one-line hint under it, plus a back arrow top-left. The arrow
 *  goes where the normal editor's own header arrow goes (`VCutApp`'s `onHome` — back to the projects
 *  list), and is left out wherever that one is: `onBack` is undefined when VCut is embedded in a host
 *  app with no list of its own to return to (see `edit/page.tsx`). A template-origin project never
 *  shows the normal editor header at all, so without this the only way off these screens was the
 *  browser's own back button — none at all in an installed/standalone app window. */
export function TemplateScreenHeader({ onBack, subtitle }: { onBack?: () => void; subtitle: ReactNode }) {
  const t = useTranslation();
  return (
    <div className="shrink-0 border-b border-white/10 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            title={t("Back to projects")}
            aria-label={t("Back to projects")}
            className="-ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={18} />
          </button>
        )}
        {/* Renameable right here — see `EditableProjectTitle`'s own doc comment for why this needs to
            live somewhere in the guided template flow at all, not just the normal editor's header. */}
        <div className="min-w-0 flex-1">
          <EditableProjectTitle variant="title" />
        </div>
      </div>
      {/* Indented to line up under the title rather than the arrow when there is one. */}
      <p className={`mt-1 text-xs text-white/50 ${onBack ? "pl-8" : ""}`}>{subtitle}</p>
    </div>
  );
}
