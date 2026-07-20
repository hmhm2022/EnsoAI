import { type FileChangeCallback, FileWatcher } from '../files/FileWatcher';

type CodexHistoryEventType = 'create' | 'update' | 'delete';

interface CodexHistoryIndexerLike {
  indexFile(filePath: string): Promise<unknown>;
}

interface CodexHistoryIndexStoreLike {
  deleteByFilePath(filePath: string): Promise<void>;
}

interface CodexHistoryWatcherSubscription {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type CodexHistoryWatcherFactory = (
  directory: string,
  callback: FileChangeCallback
) => CodexHistoryWatcherSubscription;

interface CodexHistoryWatcherOptions {
  debounceMs?: number;
  fileWatcherFactory?: CodexHistoryWatcherFactory;
}

const DEFAULT_DEBOUNCE_MS = 300;

export class CodexHistoryWatcher {
  private readonly debounceMs: number;
  private readonly fileWatcherFactory: CodexHistoryWatcherFactory;
  private pendingEvents = new Map<string, CodexHistoryEventType>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private pendingWrites = new Set<Promise<void>>();
  private watcher: CodexHistoryWatcherSubscription | null = null;
  private stopped = true;

  constructor(
    private readonly sessionsRoot: string,
    private readonly indexer: CodexHistoryIndexerLike,
    private readonly store: CodexHistoryIndexStoreLike,
    options: CodexHistoryWatcherOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileWatcherFactory =
      options.fileWatcherFactory ?? ((directory, callback) => new FileWatcher(directory, callback));
  }

  async start(): Promise<void> {
    if (!this.stopped) return;

    this.stopped = false;
    const watcher = this.fileWatcherFactory(this.sessionsRoot, this.handleFileChange);
    this.watcher = watcher;

    try {
      await watcher.start();
    } catch (error) {
      console.error('[CodexHistoryWatcher] 启动文件监听失败：', error);
      if (this.watcher === watcher) {
        this.watcher = null;
        this.stopped = true;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.stopped = true;
    this.clearPendingEvents();
    this.watcher = null;

    try {
      await watcher?.stop();
    } catch (error) {
      console.error('[CodexHistoryWatcher] 停止文件监听失败：', error);
    }

    // 所有已启动的索引写入完成后，调用方才能安全关闭数据库。
    await Promise.allSettled([...this.pendingWrites]);
  }

  stopSync(): void {
    this.stopped = true;
    this.clearPendingEvents();

    const watcher = this.watcher;
    this.watcher = null;
    void watcher?.stop().catch((error) => {
      console.error('[CodexHistoryWatcher] 停止文件监听失败：', error);
    });
  }

  private clearPendingEvents(): void {
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    this.pendingEvents.clear();
  }

  private handleFileChange = (type: CodexHistoryEventType, filePath: string): void => {
    if (this.stopped || !filePath.endsWith('.jsonl')) return;

    // 删除事件优先，避免同一批通知又把已删除的记录重新写入索引。
    if (this.pendingEvents.get(filePath) !== 'delete') {
      this.pendingEvents.set(filePath, type);
    }

    const existingTimer = this.pendingTimers.get(filePath);
    if (existingTimer) clearTimeout(existingTimer);
    this.pendingTimers.set(
      filePath,
      setTimeout(() => this.flushEvent(filePath), this.debounceMs)
    );
  };

  private flushEvent(filePath: string): void {
    const type = this.pendingEvents.get(filePath);
    this.pendingEvents.delete(filePath);
    this.pendingTimers.delete(filePath);
    if (!type || this.stopped) return;

    // 文件写入常会产生多次通知，延后后只按最终事件更新索引。
    let write: Promise<void>;
    write = this.applyEvent(type, filePath).finally(() => {
      this.pendingWrites.delete(write);
    });
    this.pendingWrites.add(write);
  }

  private async applyEvent(type: CodexHistoryEventType, filePath: string): Promise<void> {
    try {
      if (type === 'delete') {
        await this.store.deleteByFilePath(filePath);
      } else {
        await this.indexer.indexFile(filePath);
      }
    } catch (error) {
      console.error('[CodexHistoryWatcher] 更新会话索引失败：', error);
    }
  }
}
