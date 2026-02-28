export type FocusPolicyState = 'unlocked' | 'locked' | 'suspended';

export type FocusPolicyEvent =
  | 'enhanced-focus'
  | 'enhanced-close'
  | 'overlay-open'
  | 'overlay-close'
  | 'context-switch';

export type FocusAction = 'command' | 'overlay' | 'context-switch' | 'unknown';

export const OVERLAY_SELECTOR =
  '[data-slot="dialog-popup"], [data-slot="alert-dialog-popup"], [data-quick-terminal]';
export const OPEN_OVERLAY_SELECTOR = '[data-overlay-open]';

const TRANSITIONS: Record<FocusPolicyState, Partial<Record<FocusPolicyEvent, FocusPolicyState>>> = {
  unlocked: {
    'enhanced-focus': 'locked',
  },
  locked: {
    'enhanced-close': 'unlocked',
    'overlay-open': 'suspended',
    'context-switch': 'unlocked',
  },
  suspended: {
    'enhanced-close': 'unlocked',
    'overlay-close': 'locked',
    'context-switch': 'unlocked',
  },
};

export function transitionFocusPolicyState(
  state: FocusPolicyState,
  event: FocusPolicyEvent
): FocusPolicyState {
  return TRANSITIONS[state][event] ?? state;
}

export function isFocusPolicyLocked(state: FocusPolicyState): boolean {
  return state === 'locked' || state === 'suspended';
}

export function isOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(OVERLAY_SELECTOR));
}

export function isAnyOverlayOpen(): boolean {
  return Boolean(document.querySelector(OPEN_OVERLAY_SELECTOR));
}

export function getFocusActionFromTarget(target: EventTarget | null): FocusAction {
  if (!(target instanceof Element)) return 'unknown';
  const action = target.closest<HTMLElement>('[data-focus-action]')?.dataset.focusAction;
  if (action === 'command' || action === 'overlay' || action === 'context-switch') {
    return action;
  }
  return 'unknown';
}

export function isInputControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
    )
  );
}

export function isBlankAreaTarget(target: EventTarget | null): boolean {
  return target === document.body || target === document.documentElement;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function cycleTabWithinContainer(container: HTMLElement, backwards: boolean): void {
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.tabIndex >= 0 &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
  );

  if (focusables.length === 0) {
    return;
  }

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? focusables.indexOf(active) : -1;
  const step = backwards ? -1 : 1;
  const fallbackIndex = backwards ? focusables.length - 1 : 0;
  const nextIndex =
    currentIndex === -1
      ? fallbackIndex
      : (currentIndex + step + focusables.length) % focusables.length;

  focusables[nextIndex]?.focus();
}
