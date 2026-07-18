import type {
  CodexHistoryQuery,
  CodexHistoryResult,
  CodexLatestSessionQuery,
  CodexLatestSessionResult,
  CodexSessionListQuery,
  CodexSessionListResult,
} from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  findLatestCodexSession,
  getCodexHistory,
  listCodexSessions,
} from '../services/codex/CodexHistoryService';

export function registerCodexHistoryHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CODEX_HISTORY_GET,
    async (_event, query: CodexHistoryQuery): Promise<CodexHistoryResult> => {
      return getCodexHistory(query);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEX_HISTORY_FIND_LATEST,
    async (_event, query: CodexLatestSessionQuery): Promise<CodexLatestSessionResult | null> => {
      return findLatestCodexSession(query);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEX_HISTORY_LIST_SESSIONS,
    async (_event, query: CodexSessionListQuery): Promise<CodexSessionListResult> => {
      return listCodexSessions(query);
    }
  );
}
