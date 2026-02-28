export type ShortcutScope = 'system' | 'app' | 'overlay' | 'panel';

interface ShortcutMatcher {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

const SYSTEM_SHORTCUTS: ShortcutMatcher[] = [
  { key: 'w', ctrl: true },
  { key: 'w', meta: true },
  { key: 'q', ctrl: true },
  { key: 'q', meta: true },
];

const APP_SHORTCUTS: ShortcutMatcher[] = Array.from({ length: 9 }, (_, index) => ({
  key: String(index + 1),
  ctrl: true,
}));

const APP_SHORTCUTS_MAC: ShortcutMatcher[] = Array.from({ length: 9 }, (_, index) => ({
  key: String(index + 1),
  meta: true,
}));

const OVERLAY_SHORTCUTS: ShortcutMatcher[] = [
  { key: '`', ctrl: true },
  { key: '`', meta: true },
];

function matchesShortcut(event: KeyboardEvent, matcher: ShortcutMatcher): boolean {
  return (
    event.key.toLowerCase() === matcher.key.toLowerCase() &&
    event.ctrlKey === Boolean(matcher.ctrl) &&
    event.metaKey === Boolean(matcher.meta) &&
    event.altKey === Boolean(matcher.alt) &&
    event.shiftKey === Boolean(matcher.shift)
  );
}

export function classifyShortcutScope(event: KeyboardEvent): ShortcutScope {
  if (SYSTEM_SHORTCUTS.some((matcher) => matchesShortcut(event, matcher))) {
    return 'system';
  }

  if (
    APP_SHORTCUTS.some((matcher) => matchesShortcut(event, matcher)) ||
    APP_SHORTCUTS_MAC.some((matcher) => matchesShortcut(event, matcher))
  ) {
    return 'app';
  }

  if (OVERLAY_SHORTCUTS.some((matcher) => matchesShortcut(event, matcher))) {
    return 'overlay';
  }

  return 'panel';
}
