import type { WindowsConptySource, WindowsPtyBackend } from '@shared/types';
import type { ITerminalOptions } from '@xterm/xterm';

const UNKNOWN_WINDOWS_BUILD_NUMBER = 1;
const MODERN_CONPTY_MIN_BUILD_NUMBER = 21376;

export interface WindowsPtyCompatibilityContext {
  platform: string;
  osRelease?: string;
  backend?: WindowsPtyBackend;
  conptySource?: WindowsConptySource;
}

type WindowsPtyCompatibilityOptions = Partial<Pick<ITerminalOptions, 'windowsPty'>>;

function parseWindowsBuildNumber(osRelease: string | undefined): number | undefined {
  const buildNumber = Number.parseInt(osRelease?.split('.')[2] ?? '', 10);
  return Number.isFinite(buildNumber) && buildNumber > 0 ? buildNumber : undefined;
}

export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext
): WindowsPtyCompatibilityOptions {
  if (context.platform !== 'win32' || !context.backend) return {};
  if (context.backend === 'winpty') {
    return { windowsPty: { backend: 'winpty' } };
  }

  // 随包版是新版 ConPTY；系统版使用宿主 build 选择 xterm 的兼容规则。
  const buildNumber =
    context.conptySource === 'bundled'
      ? MODERN_CONPTY_MIN_BUILD_NUMBER
      : (parseWindowsBuildNumber(context.osRelease) ?? UNKNOWN_WINDOWS_BUILD_NUMBER);
  return {
    windowsPty: { backend: 'conpty', buildNumber },
  };
}
