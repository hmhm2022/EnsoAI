import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useXterm terminal display options', () => {
  const source = fs.readFileSync(path.join(__dirname, '../useXterm.ts'), 'utf-8');

  it('keeps erased display content only when Windows compatibility is enabled', () => {
    expect(source).toContain('scrollOnEraseInDisplay: useWindowsConptyCompatibility');
  });

  it('passes Windows ConPTY compatibility setting to terminal creation', () => {
    expect(source).toContain('windowsConptyCompatibilityFixEnabled');
  });

  it('passes native Windows PTY compatibility options to xterm', () => {
    expect(source).toContain('buildWindowsPtyCompatibilityOptions({');
    expect(source).toContain('osRelease: window.electronAPI.env.osRelease');
    expect(source).toContain('backend: windowsPtyBackend');
    expect(source).toContain('conptySource: windowsConptySource');
    expect(source).toContain('terminal.options.windowsPty = windowsPtyOptions.windowsPty');

    const optionsIndex = source.indexOf('terminal.options.windowsPty =');
    const activateIndex = source.indexOf('window.electronAPI.terminal.activate(ptyId)');
    expect(optionsIndex).toBeGreaterThan(-1);
    expect(optionsIndex).toBeLessThan(activateIndex);
  });
});
