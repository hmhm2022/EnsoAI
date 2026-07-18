import { existsSync, type Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  CodexHistoryQuery,
  CodexHistoryResult,
  CodexLatestSessionQuery,
  CodexLatestSessionResult,
  CodexSessionListItem,
  CodexSessionListQuery,
  CodexSessionListResult,
} from '@shared/types';
import { extractCodexSessionIdFromPath, parseCodexHistoryJsonl } from './CodexHistoryParser';

interface InternalCodexHistoryQuery extends CodexHistoryQuery {
  sessionsRoot?: string;
}

interface InternalLatestSessionQuery extends CodexLatestSessionQuery {
  sessionsRoot?: string;
}

interface InternalSessionListQuery extends CodexSessionListQuery {
  sessionsRoot?: string;
}

interface SessionFileMetadata {
  cwdValues: string[];
  cwd?: string;
  title?: string;
  timestamp?: string;
}

const SESSION_TITLE_MAX_LENGTH = 160;

function defaultSessionsRoot(): string {
  return path.join(homedir(), '.codex', 'sessions');
}

async function listJsonlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }

  return results;
}

async function findFileBySessionId(root: string, sessionId: string): Promise<string | null> {
  const files = await listJsonlFiles(root);
  return files.find((file) => extractCodexSessionIdFromPath(file) === sessionId) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function normalizeCwd(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function extractCwdValues(record: Record<string, unknown>): string[] {
  const payload = asRecord(record.payload);
  const session = asRecord(record.session);
  const payloadSession = asRecord(payload?.session);
  const metadata = asRecord(record.metadata) ?? asRecord(payload?.metadata);
  const values = [
    record.cwd,
    record.workingDirectory,
    payload?.cwd,
    payload?.workingDirectory,
    session?.cwd,
    payloadSession?.cwd,
    metadata?.cwd,
  ];

  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function extractTimestampValue(record: Record<string, unknown>): string | undefined {
  const payload = asRecord(record.payload);
  const session = asRecord(record.session);
  const payloadSession = asRecord(payload?.session);
  const metadata = asRecord(record.metadata) ?? asRecord(payload?.metadata);
  const values = [
    record.timestamp,
    payload?.timestamp,
    session?.timestamp,
    payloadSession?.timestamp,
    metadata?.timestamp,
  ];

  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function collectTextValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextValues(item, output);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const key of ['text', 'content', 'message', 'payload', 'items']) {
    if (key in record) {
      collectTextValues(record[key], output);
    }
  }
}

function normalizeSessionTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isGeneratedUserText(text: string): boolean {
  return (
    text.startsWith('# AGENTS.md instructions for') ||
    text.startsWith('<environment_context>') ||
    text.startsWith('<turn_aborted>') ||
    text.startsWith('<user_action>')
  );
}

function extractTitleValue(record: Record<string, unknown>): string | undefined {
  const payload = asRecord(record.payload);
  const role = record.role ?? payload?.role;
  if (role !== 'user') return undefined;

  const textParts: string[] = [];
  collectTextValues(record.content, textParts);
  collectTextValues(payload?.content, textParts);

  const title = normalizeSessionTitle([...new Set(textParts)].join(' '));
  if (!title || isGeneratedUserText(title)) return undefined;

  return title.length > SESSION_TITLE_MAX_LENGTH
    ? `${title.slice(0, SESSION_TITLE_MAX_LENGTH).trim()}...`
    : title;
}

function parseTimestampMs(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : null;
}

function extractCreatedAtMsFromRolloutPath(filePath: string): number | null {
  const filename = path.basename(filePath);
  const match = filename.match(
    /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f-]{36}\.jsonl$/i
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;
  return parseTimestampMs(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`);
}

function getSessionCreatedAtMs(
  filePath: string,
  metadata: SessionFileMetadata,
  fileStat: Pick<Stats, 'birthtimeMs' | 'ctimeMs'>
): number {
  return (
    parseTimestampMs(metadata.timestamp) ??
    extractCreatedAtMsFromRolloutPath(filePath) ??
    fileStat.birthtimeMs ??
    fileStat.ctimeMs
  );
}

async function readSessionFileMetadata(filePath: string): Promise<SessionFileMetadata> {
  const content = await readFile(filePath, 'utf8');
  const cwdValues: string[] = [];
  let timestamp: string | undefined;
  let title: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = asRecord(JSON.parse(trimmed) as unknown);
      if (!record) continue;

      cwdValues.push(...extractCwdValues(record));
      timestamp ??= extractTimestampValue(record);
      title ??= extractTitleValue(record);
    } catch {
      // Codex jsonl 里可能存在不完整行，这里只跳过坏行。
    }
  }

  const metadata: SessionFileMetadata = { cwdValues };
  if (cwdValues[0]) metadata.cwd = cwdValues[0];
  if (title) metadata.title = title;
  if (timestamp) metadata.timestamp = timestamp;
  return metadata;
}

function metadataMatchesCwd(metadata: SessionFileMetadata, cwd?: string): boolean {
  if (!cwd) return true;
  const expected = normalizeCwd(cwd);
  if (!expected) return true;

  return metadata.cwdValues.some((value) => normalizeCwd(value) === expected);
}

function createSessionListItem(
  sessionId: string,
  filePath: string,
  modifiedAt: number,
  metadata: SessionFileMetadata
): CodexSessionListItem {
  const item: CodexSessionListItem = { sessionId, filePath, modifiedAt };
  if (metadata.cwd) item.cwd = metadata.cwd;
  if (metadata.title) item.title = metadata.title;
  if (metadata.timestamp) item.timestamp = metadata.timestamp;
  return item;
}

export async function listCodexSessions({
  cwd,
  maxSessions = 50,
  sessionsRoot = defaultSessionsRoot(),
}: InternalSessionListQuery): Promise<CodexSessionListResult> {
  const files = await listJsonlFiles(sessionsRoot);
  const sessions: CodexSessionListItem[] = [];

  for (const filePath of files) {
    const sessionId = extractCodexSessionIdFromPath(filePath);
    if (!sessionId) continue;

    const [fileStat, metadata] = await Promise.all([
      stat(filePath),
      readSessionFileMetadata(filePath),
    ]);
    // 旧 EnsoAI 记录没有 cliSessionId 时，用户只能从当前 cwd 下的 Codex 文件里选。
    if (!metadataMatchesCwd(metadata, cwd)) continue;

    sessions.push(createSessionListItem(sessionId, filePath, fileStat.mtimeMs, metadata));
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return { sessions: sessions.slice(0, maxSessions) };
}

export async function findLatestCodexSession({
  cwd,
  startedAfter = 0,
  sessionsRoot = defaultSessionsRoot(),
}: InternalLatestSessionQuery): Promise<CodexLatestSessionResult | null> {
  const files = await listJsonlFiles(sessionsRoot);
  const candidates: Array<{ sessionId: string; filePath: string; createdAtMs: number }> = [];

  for (const filePath of files) {
    const sessionId = extractCodexSessionIdFromPath(filePath);
    if (!sessionId) continue;

    const [fileStat, metadata] = await Promise.all([
      stat(filePath),
      readSessionFileMetadata(filePath),
    ]);
    if (!metadataMatchesCwd(metadata, cwd)) continue;

    // 新建 Codex 会话时，旧会话文件也可能继续被写入；这里只按会话创建时间判断。
    const createdAtMs = getSessionCreatedAtMs(filePath, metadata, fileStat);
    if (createdAtMs < startedAfter) continue;

    candidates.push({ sessionId, filePath, createdAtMs });
  }

  candidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const latest = candidates[0];
  if (latest) return { sessionId: latest.sessionId, filePath: latest.filePath };

  return null;
}

export async function getCodexHistory({
  sessionId,
  maxMessages = 500,
  sessionsRoot = defaultSessionsRoot(),
}: InternalCodexHistoryQuery): Promise<CodexHistoryResult> {
  if (!sessionId) {
    return {
      sessionId: null,
      filePath: null,
      messages: [],
      truncated: false,
      error: 'missing-session-id',
    };
  }

  const filePath = await findFileBySessionId(sessionsRoot, sessionId);
  if (!filePath) {
    return {
      sessionId,
      filePath: null,
      messages: [],
      truncated: false,
      error: 'session-file-not-found',
    };
  }

  const content = await readFile(filePath, 'utf8');
  const parsed = parseCodexHistoryJsonl(content, maxMessages);
  return { sessionId, filePath, messages: parsed.messages, truncated: parsed.truncated };
}
