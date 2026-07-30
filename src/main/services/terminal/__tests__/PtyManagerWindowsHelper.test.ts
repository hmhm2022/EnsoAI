import { describe, expect, it, vi } from 'vitest';
import type {
  WindowsPtyHelperAttempt,
  WindowsPtyHelperCallbacks,
  WindowsPtyHelperRequest,
  WindowsPtyHelperSession,
} from '../WindowsPtyHelper';

vi.mock('../windowsConptyCompatibility', () => ({
  createWindowsConptyCompatibilityOptions: ({ settingEnabled }: { settingEnabled?: boolean }) => ({
    useConptyDll: settingEnabled === true,
    reason: settingEnabled === true ? 'enabled' : 'disabled',
  }),
}));

import { PtyManager, type PtyManagerDependencies } from '../PtyManager';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createFakeSession(
  helperPid = 9001,
  ptyPid = 9002,
  overrides: Partial<WindowsPtyHelperSession> = {}
): WindowsPtyHelperSession {
  return {
    helperPid,
    ptyPid,
    activate: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    destroyAndWait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createOptions() {
  return {
    shell: 'cmd.exe',
    cols: 80,
    rows: 24,
    cwd: 'C:\\work',
    windowsConptyCompatibilityFixEnabled: false,
  };
}

function createManager(
  startWindowsPtyHelper: NonNullable<PtyManagerDependencies['startWindowsPtyHelper']>,
  osRelease = '10.0.19045'
): PtyManager {
  return new PtyManager({
    platform: 'win32',
    osRelease,
    startWindowsPtyHelper,
  });
}

describe('PtyManager Windows helper integration', () => {
  it('returns an id only after the helper is ready and routes writes', async () => {
    const ready = deferred<WindowsPtyHelperSession>();
    const session = createFakeSession();
    const start = vi.fn(
      (
        _request: WindowsPtyHelperRequest,
        _callbacks: WindowsPtyHelperCallbacks
      ): WindowsPtyHelperAttempt => ({
        helperPid: session.helperPid,
        ready: ready.promise,
        cancel: vi.fn().mockResolvedValue(undefined),
      })
    );
    const manager = createManager(start);

    const pending = manager.create(createOptions(), vi.fn(), vi.fn(), 9);
    await Promise.resolve();
    ready.resolve(session);

    const result = await pending;
    manager.write(result.id, 'echo ready\r');
    expect(result.windowsPtyBackend).toBe('conpty');
    expect(result.windowsConptySource).toBe('system');
    expect(session.write).toHaveBeenCalledWith('echo ready\r');
    expect(session.activate).not.toHaveBeenCalled();

    manager.activate(result.id);
    manager.activate(result.id);
    expect(session.activate).toHaveBeenCalledTimes(1);
  });

  it('cancels a helper while it is still creating when its owner is destroyed', async () => {
    const ready = deferred<WindowsPtyHelperSession>();
    const cancel = vi.fn(() => {
      ready.reject(new Error('creation cancelled'));
      return Promise.resolve();
    });
    const start = vi.fn(
      (): WindowsPtyHelperAttempt => ({
        helperPid: 9010,
        ready: ready.promise,
        cancel,
      })
    );
    const manager = createManager(start);
    const pending = manager.create(createOptions(), vi.fn(), vi.fn(), 10);

    manager.destroyByOwner(10);

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it('retries with system ConPTY after bundled ConPTY fails', async () => {
    const useConptyValues: boolean[] = [];
    const session = createFakeSession(9020, 9021);
    const start = vi.fn((request: WindowsPtyHelperRequest): WindowsPtyHelperAttempt => {
      useConptyValues.push(request.options.useConptyDll === true);
      if (useConptyValues.length === 1) {
        return {
          helperPid: 9022,
          ready: Promise.reject(new Error('bundled failed')),
          cancel: vi.fn().mockResolvedValue(undefined),
        };
      }
      return {
        helperPid: session.helperPid,
        ready: Promise.resolve(session),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
    });
    const manager = createManager(start);

    const result = await manager.create(
      { ...createOptions(), windowsConptyCompatibilityFixEnabled: true },
      vi.fn(),
      vi.fn(),
      11
    );

    expect(useConptyValues).toEqual([true, false]);
    expect(result.windowsPtyBackend).toBe('conpty');
    expect(result.windowsConptySource).toBe('system');
  });

  it('reports bundled ConPTY when the bundled helper succeeds', async () => {
    const session = createFakeSession(9030, 9031);
    const manager = createManager(
      (): WindowsPtyHelperAttempt => ({
        helperPid: session.helperPid,
        ready: Promise.resolve(session),
        cancel: vi.fn().mockResolvedValue(undefined),
      })
    );

    const result = await manager.create(
      { ...createOptions(), windowsConptyCompatibilityFixEnabled: true },
      vi.fn(),
      vi.fn(),
      12
    );

    expect(result.windowsPtyBackend).toBe('conpty');
    expect(result.windowsConptySource).toBe('bundled');
  });

  it('reports WinPTY on Windows builds below 18309', async () => {
    const session = createFakeSession(9040, 9041);
    const requests: WindowsPtyHelperRequest[] = [];
    const manager = createManager((request): WindowsPtyHelperAttempt => {
      requests.push(request);
      return {
        helperPid: session.helperPid,
        ready: Promise.resolve(session),
        cancel: vi.fn().mockResolvedValue(undefined),
      };
    }, '10.0.17763');

    const result = await manager.create(
      { ...createOptions(), windowsConptyCompatibilityFixEnabled: true },
      vi.fn(),
      vi.fn(),
      13
    );

    expect(result).toEqual({ id: expect.any(String), windowsPtyBackend: 'winpty' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.options).toMatchObject({ useConpty: false, useConptyDll: false });
  });
});
