import type { ReactNode } from "react";

/** One tool inside a toolbar group (Text, Audio). Choosing a group's toolbar button expands the toolbar row in
 *  place to show that group's tools, each rendered as an ordinary toolbar button from one of these. `active`
 *  marks a toggle that is on (Mute) or a panel that is open (Mixer, Animation). */
export interface ToolGroupItem {
  id: string;
  label: string;
  /** Shorter text for the toolbar button (defaults to `label`) — buttons are narrow. */
  shortLabel?: string;
  /** Also the button's tooltip. */
  description: string;
  icon: ReactNode;
  active?: boolean;
  onSelect: () => void;
}
