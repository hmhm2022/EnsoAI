import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractCodexSessionIdFromPath } from './CodexHistoryParser';

const SESSION_TITLE_MAX_LENGTH = 160;

export interface ParseCodexSessionMetadataInput {
  filePath: string;
  content: string;
  fileStat: Pick<Stats, 'birthtimeMs' | 'ctimeMs' | 'mtimeMs' | 'size'>;
}

export interface CodexSessionMetadata {
  sessionId: string;
  filePath: string;
  cwdValues: string[];
  cwdNormalizedValues: string[];
  createdAtMs: number;
  modifiedAtMs: number;
  fileMtimeMs: number;
  fileSize: number;
  cwd?: string;
  title?: string;
  timestamp?: string;
  model?: string;
  modelProvider?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function normalizeCwd(value: string): string {
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

function extractFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  const payload = asRecord(record.payload);
  const session = asRecord(record.session);
  const payloadSession = asRecord(payload?.session);
  const metadata = asRecord(record.metadata) ?? asRecord(payload?.metadata);
  const values = [record, payload, session, payloadSession, metadata].flatMap((source) =>
    keys.map((key) => source?.[key])
  );
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function extractMetadataSessionId(record: Record<string, unknown>): string | undefined {
  const explicitSessionId = extractFirstString(record, ['session_id']);
  if (explicitSessionId) return explicitSessionId;

  return record.type === 'session_meta'
    ? extractFirstString(record, ['sessionId', 'id'])
    : undefined;
}

function collectTextValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const key of ['text', 'content', 'message', 'payload', 'items']) {
    if (key in record) collectTextValues(record[key], output);
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

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseCodexSessionMetadata({
  filePath,
  content,
  fileStat,
}: ParseCodexSessionMetadataInput): CodexSessionMetadata | null {
  const cwdValues: string[] = [];
  let metadataSessionId: string | undefined;
  let timestamp: string | undefined;
  let title: string | undefined;
  let model: string | undefined;
  let modelProvider: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const record = asRecord(JSON.parse(trimmed) as unknown);
      if (!record) continue;

      cwdValues.push(...extractCwdValues(record));
      metadataSessionId ??= extractMetadataSessionId(record);
      timestamp ??= extractFirstString(record, ['timestamp']);
      model ??= extractFirstString(record, ['model']);
      modelProvider ??= extractFirstString(record, ['model_provider', 'modelProvider']);
      title ??= extractTitleValue(record);
    } catch {
      // Codex jsonl 里可能存在不完整行，这里只跳过坏行。
    }
  }

  const sessionId = extractCodexSessionIdFromPath(filePath) ?? metadataSessionId;
  if (!sessionId) return null;

  const uniqueCwdValues = uniqueValues(cwdValues);
  const cwdNormalizedValues = uniqueValues(uniqueCwdValues.map(normalizeCwd));
  const createdAtMs =
    parseTimestampMs(timestamp) ??
    extractCreatedAtMsFromRolloutPath(filePath) ??
    fileStat.birthtimeMs ??
    fileStat.ctimeMs;

  const metadata: CodexSessionMetadata = {
    sessionId,
    filePath,
    cwdValues: uniqueCwdValues,
    cwdNormalizedValues,
    createdAtMs,
    modifiedAtMs: fileStat.mtimeMs,
    fileMtimeMs: fileStat.mtimeMs,
    fileSize: fileStat.size,
  };
  if (uniqueCwdValues[0]) metadata.cwd = uniqueCwdValues[0];
  if (title) metadata.title = title;
  if (timestamp) metadata.timestamp = timestamp;
  if (model) metadata.model = model;
  if (modelProvider) metadata.modelProvider = modelProvider;
  return metadata;
}

export async function readCodexSessionMetadata(
  filePath: string
): Promise<CodexSessionMetadata | null> {
  const [content, fileStat] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
  return parseCodexSessionMetadata({ filePath, content, fileStat });
}
