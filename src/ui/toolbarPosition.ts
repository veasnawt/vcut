export type ToolbarPosition = "left" | "bottom";

export const TOOLBAR_POSITION_STORAGE_KEY = "vcut-toolbar-position";

export function readToolbarPosition(storage?: Pick<Storage, "getItem">): ToolbarPosition {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    return source?.getItem(TOOLBAR_POSITION_STORAGE_KEY) === "bottom" ? "bottom" : "left";
  } catch {
    return "left";
  }
}

export function effectiveToolbarPosition(preference: ToolbarPosition, desktop: boolean): ToolbarPosition {
  return desktop ? preference : "bottom";
}
