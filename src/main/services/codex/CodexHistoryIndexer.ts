import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodexHistoryIndexStore } from './CodexHistoryIndexStore';
import {
  type CodexSessionMetadata,
  normalizeCwd,
  readCodexSessionMetadata,
} from './CodexHistoryMetadata';

const FULL_SCAN_BATCH_SIZE = 50;

interface RecentScanOptions {
  maxFiles: number;
  newerThanMs?: number;
  cwd?: string;
  startedAfter?: number;
}

interface FileWithMtime {
  filePath: string;
  mtimeMs: number;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readMetadataForIndexing(
  store: CodexHistoryIndexStore,
  filePath: string
): Promise<CodexSessionMetadata | null> {
  try {
    return await readCodexSessionMetadata(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;

    // 文件在索引时被删除时，直接清掉旧记录，避免留下过期索引。
    await store.deleteByFilePath(filePath);
    return null;
  }
}

export async function listCodexJsonlFiles(root: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readCodexDirectory>>;
  try {
    entries = await readCodexDirectory(root);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listCodexJsonlFiles(filePath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(filePath);
    }
  }

  return files;
}

function readCodexDirectory(root: string) {
  return readdir(root, { withFileTypes: true, encoding: 'utf8' });
}

export class CodexHistoryIndexer {
  constructor(
    private readonly store: CodexHistoryIndexStore,
    private readonly sessionsRoot: string
  ) {}

  async indexFile(filePath: string): Promise<CodexSessionMetadata | null> {
    const metadata = await readMetadataForIndexing(this.store, filePath);
    if (metadata) await this.store.upsertSession(metadata);
    return metadata;
  }

  async indexFiles(filePaths: string[]): Promise<CodexSessionMetadata[]> {
    const metadata = (
      await Promise.all(filePaths.map((filePath) => readMetadataForIndexing(this.store, filePath)))
    ).filter((record): record is CodexSessionMetadata => record !== null);

    if (metadata.length > 0) await this.store.upsertSessions(metadata);
    return metadata;
  }

  async runFullScan(): Promise<void> {
    const files = await listCodexJsonlFiles(this.sessionsRoot);

    // 全量扫描分批让出事件循环，避免大量历史文件阻塞主进程。
    for (let start = 0; start < files.length; start += FULL_SCAN_BATCH_SIZE) {
      await this.indexFiles(files.slice(start, start + FULL_SCAN_BATCH_SIZE));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await this.store.deleteMissingFiles(new Set(files));
    await this.store.setState('initial_scan_completed', 'true');
    await this.store.setState('last_full_scan_at_ms', String(Date.now()));
  }

  async runRecentScan(options: RecentScanOptions): Promise<CodexSessionMetadata[]> {
    const files = await listCodexJsonlFiles(this.sessionsRoot);
    const candidates = await this.getFilesSortedByMtime(files, options.newerThanMs);
    const selectedFiles = candidates
      .slice(0, Math.max(0, options.maxFiles))
      .map(({ filePath }) => filePath);
    const metadata = await this.indexFiles(selectedFiles);
    const normalizedCwd = options.cwd ? normalizeCwd(options.cwd) : undefined;

    return metadata.filter((record) => {
      if (normalizedCwd && !record.cwdNormalizedValues.includes(normalizedCwd)) return false;
      return options.startedAfter === undefined || record.createdAtMs >= options.startedAfter;
    });
  }

  private async getFilesSortedByMtime(
    filePaths: string[],
    newerThanMs: number | undefined
  ): Promise<FileWithMtime[]> {
    const filesWithMtime = await Promise.all(
      filePaths.map(async (filePath): Promise<FileWithMtime | null> => {
        try {
          const fileStat = await stat(filePath);
          if (newerThanMs !== undefined && fileStat.mtimeMs < newerThanMs) return null;
          return { filePath, mtimeMs: fileStat.mtimeMs };
        } catch (error) {
          if (isMissingFileError(error)) return null;
          throw error;
        }
      })
    );

    return filesWithMtime
      .filter((file): file is FileWithMtime => file !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  }
}
