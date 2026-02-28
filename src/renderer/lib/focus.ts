export function isFocusedInsideEnhancedInput(sessionId: string): boolean {
  let element = document.activeElement as HTMLElement | null;
  while (element) {
    if (element.dataset.enhancedInputSession === sessionId) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function getEnhancedInputElement(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-enhanced-input-session="${CSS.escape(sessionId)}"]`
  );
}

export function isTargetInsideEnhancedInputSession(
  target: EventTarget | null,
  sessionId: string
): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest<HTMLElement>(`[data-enhanced-input-session="${CSS.escape(sessionId)}"]`)
  );
}
