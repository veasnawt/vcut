/** The Collage toolbar icon: one tall cell beside two stacked ones (a "big + 2" layout). Drawn here because the shared icon set's
 *  only grid glyph is already the Styles button's. Sized and coloured like the shared icons (`size`, `currentColor`). */
export function CollageIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="10" height="18" rx="2" />
      <rect x="15.5" y="3" width="5.5" height="8" rx="1.6" />
      <rect x="15.5" y="13" width="5.5" height="8" rx="1.6" />
    </svg>
  );
}
