/** An outgoing transition may request media past EOF. Never call play() there: browsers restart
 *  ended elements. Seeking just inside EOF also supplies the last frame when scrubbing into a blend. */
export function holdMediaAtEnd(element: HTMLMediaElement, sourceTime: number): boolean {
  if (!Number.isFinite(element.duration) || element.duration <= 0 || sourceTime < element.duration - 1e-6) return false;
  if (!element.paused) element.pause();
  const lastFrameTime = Math.max(0, element.duration - 0.0001);
  if (element.readyState > 0 && !element.ended && !element.seeking && Math.abs(element.currentTime - lastFrameTime) > 0.00001) {
    element.currentTime = lastFrameTime;
  }
  return true;
}
