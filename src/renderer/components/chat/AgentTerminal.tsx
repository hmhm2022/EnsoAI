import type { FileEntry } from '@shared/types';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodexViewSessionButton } from '@/components/chat/CodexViewSessionButton';
import {
  TerminalSearchBar,
  type TerminalSearchBarRef,
} from '@/components/terminal/TerminalSearchBar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useTerminalScrollToBottom } from '@/hooks/useTerminalScrollToBottom';
import { useXterm } from '@/hooks/useXterm';
import { useI18n } from '@/i18n';
import { type OutputState, useAgentSessionsStore } from '@/stores/agentSessions';
import { useSettingsStore } from '@/stores/settings';
import { useTerminalWriteStore } from '@/stores/terminalWrite';
import { useWorktreeActivityStore } from '@/stores/worktreeActivity';

interface AgentTerminalProps {
  id?: string; // Terminal session ID (UI key)
  cwd?: string;
  sessionId?: string; // Claude session ID for --session-id/--resume (falls back to id)
  agentId?: string; // Agent ID (e.g., 'claude', 'codex', 'gemini')
  agentCommand?: string;
  customPath?: string; // custom absolute path to the agent CLI
  customArgs?: string; // additional arguments to pass to the agent
  environment?: 'native' | 'hapi' | 'happy';
  initialized?: boolean;
  activated?: boolean;
  isActive?: boolean;
  canMerge?: boolean; // whether merge option should be enabled (has multiple groups)
  /**
   * When provided, Enhanced Input open state is controlled by parent (e.g. AgentPanel store).
   * When omitted, AgentTerminal falls back to its own local state.
   */
  enhancedInputOpen?: boolean;
  onEnhancedInputOpenChange?: (open: boolean) => void;
  onInitialized?: () => void;
  onActivated?: () => void;
  /** Called when session is activated with the current line content (for session name fallback). */
  onActivatedWithFirstLine?: (line: string) => void;
  onExit?: () => void;
  onTerminalTitleChange?: (title: string) => void;
  onSplit?: () => void;
  onMerge?: () => void;
  onFocus?: () => void; // called when terminal is clicked/focused to activate the group
  onRegisterEnhancedInputSender?: (
    sessionId: string,
    sender: (content: string, imagePaths: string[]) => void
  ) => void;
  onUnregisterEnhancedInputSender?: (sessionId: string) => void;
}

const MIN_RUNTIME_FOR_AUTO_CLOSE = 10000; // 10 seconds
const MIN_OUTPUT_FOR_NOTIFICATION = 100; // Minimum chars to consider agent is doing work
const MIN_OUTPUT_FOR_INDICATOR = 200; // Minimum chars to show "outputting" indicator (higher to avoid noise)
const ACTIVITY_POLL_INTERVAL_MS = 1000; // Poll process activity every 1000ms
const IDLE_CONFIRMATION_COUNT = 2; // Require 2 consecutive idle polls (2 seconds) before marking as idle
const RECENT_OUTPUT_TIMEOUT_MS = 3000; // If output received within this time, consider still active
const MAX_CODEX_SESSION_CANDIDATES = 12;
const MAX_CODEX_TOOL_ARGUMENT_CHARS = 4000;
const MAX_CODEX_TOOL_OUTPUT_CHARS = 8000;
const MAX_CODEX_OUTPUT_PROBE_CHARS = 4000;
const MAX_CODEX_HISTORY_LINES = 40;
const MAX_CODEX_PROMPT_OBSERVATIONS = 4;
const MAX_CODEX_HISTORY_DAY_OFFSETS = [-1, 0, 1] as const;

type CodexTranscriptEntryKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'commentary'
  | 'tool-call'
  | 'tool-output';

interface CodexTranscriptEntry {
  kind: CodexTranscriptEntryKind;
  title: string;
  body: string;
  timestamp?: string;
  detail?: string;
}

interface CodexTranscriptState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  entries: CodexTranscriptEntry[];
  copyText: string;
  error: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  updatedAt: string | null;
}

interface CodexSessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
}

interface CodexSessionMetaEnvelopePayload {
  meta?: CodexSessionMetaPayload;
}

interface CodexTranscriptDocument {
  entries: CodexTranscriptEntry[];
  copyText: string;
  meta: CodexSessionMetaPayload | null;
  diagnostics: {
    nonEmptyLineCount: number;
    invalidJsonLineCount: number;
  };
}

interface CodexBoundSession {
  sessionId: string;
  sessionFilePath: string;
  historyTs?: number;
}

const EMPTY_CODEX_TRANSCRIPT_STATE: CodexTranscriptState = {
  status: 'idle',
  entries: [],
  copyText: '',
  error: null,
  sessionId: null,
  sessionFilePath: null,
  updatedAt: null,
};

const CODEX_TRANSCRIPT_CARD_STYLES: Record<CodexTranscriptEntryKind, string> = {
  user: 'border-blue-500/25 bg-blue-500/5',
  assistant: 'border-emerald-500/25 bg-emerald-500/5',
  reasoning: 'border-orange-500/25 bg-orange-500/5',
  commentary: 'border-amber-500/25 bg-amber-500/5',
  'tool-call': 'border-fuchsia-500/25 bg-fuchsia-500/5',
  'tool-output': 'border-slate-500/25 bg-slate-500/5',
};

function normalizeCodexTranscriptText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normalizeCodexMatchingText(text: string): string {
  return normalizeCodexTranscriptText(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function stringifyCodexValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCodexStructuredText(value: unknown): string {
  const raw = stringifyCodexValue(value).trim();
  if (!raw) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function truncateCodexTranscriptText(text: string, maxChars: number): string {
  const normalized = normalizeCodexTranscriptText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n[...trimmed ${normalized.length - maxChars} chars]`;
}

function extractCodexPlainTextChunks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') {
      return [];
    }
    const text = normalizeCodexTranscriptText(item.text);
    return text ? [text] : [];
  });
}

function buildCodexTranscriptDetail(
  fields: Array<[label: string, value: unknown]>
): string | undefined {
  const parts = fields.flatMap(([label, value]) => {
    if (value === undefined || value === null) {
      return [];
    }

    const text = normalizeCodexTranscriptText(String(value));
    return text ? [`${label}: ${text}`] : [];
  });

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatCodexToolCallBody(value: unknown): string {
  return truncateCodexTranscriptText(
    formatCodexStructuredText(value) || 'No arguments.',
    MAX_CODEX_TOOL_ARGUMENT_CHARS
  );
}

function formatCodexToolOutputBody(value: unknown): string {
  const plainText = extractCodexPlainTextChunks(value);
  return truncateCodexTranscriptText(
    plainText.length > 0 ? plainText.join('\n\n') : stringifyCodexValue(value),
    MAX_CODEX_TOOL_OUTPUT_CHARS
  );
}

function formatCodexReasoningBody(payload: Record<string, unknown>): string {
  const sections: string[] = [];
  const summaryTexts = extractCodexPlainTextChunks(payload.summary);
  const contentTexts = extractCodexPlainTextChunks(payload.content);

  if (summaryTexts.length > 0) {
    sections.push(summaryTexts.join('\n\n'));
  }
  if (contentTexts.length > 0) {
    sections.push(contentTexts.join('\n\n'));
  }

  return sections.length > 0
    ? truncateCodexTranscriptText(sections.join('\n\n'), MAX_CODEX_TOOL_OUTPUT_CHARS)
    : '';
}

function formatCodexLocalShellActionBody(action: unknown): string {
  if (!action || typeof action !== 'object') {
    return formatCodexStructuredText(action) || 'No arguments.';
  }

  const command =
    'command' in action && Array.isArray(action.command)
      ? action.command
          .map((part) => (typeof part === 'string' ? part : stringifyCodexValue(part)))
          .filter(Boolean)
      : [];
  const workingDirectory =
    'working_directory' in action && typeof action.working_directory === 'string'
      ? action.working_directory
      : null;
  const timeoutMs =
    'timeout_ms' in action && action.timeout_ms !== undefined ? action.timeout_ms : null;
  const user = 'user' in action && typeof action.user === 'string' ? action.user : null;
  const envKeys =
    'env' in action && action.env && typeof action.env === 'object'
      ? Object.keys(action.env as Record<string, unknown>).filter(Boolean)
      : [];

  const lines: string[] = [];
  if (command.length > 0) {
    lines.push(command.join(' '));
  }
  if (workingDirectory) {
    lines.push(`cwd: ${workingDirectory}`);
  }
  if (timeoutMs !== null) {
    lines.push(`timeout_ms: ${String(timeoutMs)}`);
  }
  if (user) {
    lines.push(`user: ${user}`);
  }
  if (envKeys.length > 0) {
    lines.push(`env: ${envKeys.join(', ')}`);
  }

  return normalizeCodexTranscriptText(lines.join('\n')) || formatCodexStructuredText(action);
}

function formatCodexWebSearchActionBody(action: unknown): string {
  if (!action || typeof action !== 'object') {
    return formatCodexStructuredText(action) || 'No arguments.';
  }

  const actionType = 'type' in action && typeof action.type === 'string' ? action.type : 'other';
  const query =
    'query' in action && typeof action.query === 'string' ? action.query.trim() : '';
  const queries =
    'queries' in action && Array.isArray(action.queries)
      ? action.queries
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const url = 'url' in action && typeof action.url === 'string' ? action.url.trim() : '';
  const pattern =
    'pattern' in action && typeof action.pattern === 'string' ? action.pattern.trim() : '';

  const lines: string[] = [`action: ${actionType}`];
  if (query) {
    lines.push(`query: ${query}`);
  }
  if (queries.length > 0) {
    lines.push(`queries: ${queries.join(' | ')}`);
  }
  if (url) {
    lines.push(`url: ${url}`);
  }
  if (pattern) {
    lines.push(`pattern: ${pattern}`);
  }

  return normalizeCodexTranscriptText(lines.join('\n')) || formatCodexStructuredText(action);
}

function formatCodexImageGenerationBody(payload: Record<string, unknown>): string {
  const revisedPrompt =
    typeof payload.revised_prompt === 'string'
      ? normalizeCodexTranscriptText(payload.revised_prompt)
      : '';
  const result = typeof payload.result === 'string' ? normalizeCodexTranscriptText(payload.result) : '';

  const sections: string[] = [];
  if (revisedPrompt) {
    sections.push(`revised_prompt:\n${revisedPrompt}`);
  }
  if (result) {
    sections.push(`result:\n${result}`);
  }

  return formatCodexToolCallBody(sections.join('\n\n') || 'No arguments.');
}

function formatCodexCompactionBody(payload: Record<string, unknown>): string {
  const encryptedContent =
    typeof payload.encrypted_content === 'string'
      ? normalizeCodexTranscriptText(payload.encrypted_content)
      : '';

  if (!encryptedContent) {
    return 'Compaction event preserved in transcript.';
  }

  return truncateCodexTranscriptText(
    `Compaction event preserved in transcript.\n\nencrypted_content:\n${encryptedContent}`,
    MAX_CODEX_TOOL_ARGUMENT_CHARS
  );
}

function appendCodexTranscriptEntriesFromResponseItem(
  entries: CodexTranscriptEntry[],
  payload: Record<string, unknown>,
  timestamp?: string
): void {
  switch (payload.type) {
    case 'message': {
      const role = typeof payload.role === 'string' ? payload.role : '';
      if (role === 'developer' || role === 'system') {
        break;
      }

      const body = extractCodexMessageText(payload.content);
      if (!body) {
        break;
      }

      if (role === 'user') {
        entries.push({ kind: 'user', title: 'User', body, timestamp });
        break;
      }

      if (payload.phase === 'commentary') {
        entries.push({ kind: 'commentary', title: 'Commentary', body, timestamp });
        break;
      }

      entries.push({ kind: 'assistant', title: 'Assistant', body, timestamp });
      break;
    }
    case 'reasoning': {
      const body = formatCodexReasoningBody(payload);
      if (!body) {
        break;
      }

      entries.push({ kind: 'reasoning', title: 'Reasoning', body, timestamp });
      break;
    }
    case 'local_shell_call': {
      const body = formatCodexToolCallBody(formatCodexLocalShellActionBody(payload.action));
      entries.push({
        kind: 'tool-call',
        title: 'Tool Call · shell',
        body,
        detail: buildCodexTranscriptDetail([
          ['call_id', typeof payload.call_id === 'string' ? payload.call_id : null],
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'function_call': {
      const name = typeof payload.name === 'string' ? payload.name : 'tool';
      const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
      const displayName = namespace ? `${namespace}.${name}` : name;
      const body = formatCodexToolCallBody(payload.arguments);
      entries.push({
        kind: 'tool-call',
        title: `Tool Call · ${displayName}`,
        body,
        detail: buildCodexTranscriptDetail([
          ['call_id', typeof payload.call_id === 'string' ? payload.call_id : null],
        ]),
        timestamp,
      });
      break;
    }
    case 'tool_search_call': {
      const body = formatCodexToolCallBody(payload.arguments);
      entries.push({
        kind: 'tool-call',
        title: 'Tool Call · search',
        body,
        detail: buildCodexTranscriptDetail([
          ['call_id', payload.call_id],
          ['execution', payload.execution],
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'web_search_call': {
      const body = formatCodexToolCallBody(formatCodexWebSearchActionBody(payload.action));
      entries.push({
        kind: 'tool-call',
        title: 'Tool Call · web_search',
        body,
        detail: buildCodexTranscriptDetail([
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'image_generation_call': {
      const body = formatCodexImageGenerationBody(payload);
      entries.push({
        kind: 'tool-call',
        title: 'Tool Call · image_generation',
        body,
        detail: buildCodexTranscriptDetail([
          ['id', payload.id],
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'compaction': {
      entries.push({
        kind: 'commentary',
        title: 'Commentary',
        body: formatCodexCompactionBody(payload),
        detail: 'compaction',
        timestamp,
      });
      break;
    }
    case 'custom_tool_call': {
      const name = typeof payload.name === 'string' ? payload.name : 'custom_tool';
      const body = formatCodexToolCallBody(payload.input);
      entries.push({
        kind: 'tool-call',
        title: `Tool Call · ${name}`,
        body,
        detail: buildCodexTranscriptDetail([
          ['call_id', typeof payload.call_id === 'string' ? payload.call_id : null],
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'function_call_output': {
      const output = formatCodexToolOutputBody(payload.output);
      if (!output) {
        break;
      }
      entries.push({
        kind: 'tool-output',
        title: 'Tool Output',
        body: output,
        detail: buildCodexTranscriptDetail([
          ['call_id', typeof payload.call_id === 'string' ? payload.call_id : null],
        ]),
        timestamp,
      });
      break;
    }
    case 'tool_search_output': {
      const output = formatCodexToolOutputBody(payload.tools);
      if (!output) {
        break;
      }
      entries.push({
        kind: 'tool-output',
        title: 'Tool Output · search',
        body: output,
        detail: buildCodexTranscriptDetail([
          ['call_id', payload.call_id],
          ['execution', payload.execution],
          ['status', payload.status],
        ]),
        timestamp,
      });
      break;
    }
    case 'custom_tool_call_output': {
      const output = formatCodexToolOutputBody(payload.output);
      if (!output) {
        break;
      }
      entries.push({
        kind: 'tool-output',
        title: 'Tool Output · custom',
        body: output,
        detail: buildCodexTranscriptDetail([
          ['call_id', typeof payload.call_id === 'string' ? payload.call_id : null],
        ]),
        timestamp,
      });
      break;
    }
  }
}

function formatCodexTimestamp(timestamp?: string): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

function normalizePathForComparison(path?: string): string {
  let normalized = (path ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');

  if (window.electronAPI.env.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function joinCodexPath(separator: string, ...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]+$/g, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')
    )
    .join(separator);
}

function stripAnsiForCodexProbe(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\u001b[@-_]/g, ' ');
}

function extractCodexSessionIdFromProbe(text: string): string | null {
  const match = text.match(/(?:session id|session_id)\s*[:=]\s*([0-9a-f-]{20,})/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isCodexScaffoldMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('# AGENTS.md instructions') ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<permissions instructions>') ||
    trimmed.startsWith('<turn_aborted>') ||
    trimmed.startsWith('<collaboration_mode>') ||
    trimmed.startsWith('<skills_instructions>') ||
    trimmed.startsWith('<INSTRUCTIONS>')
  );
}

function extractCodexMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  const chunks = content.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') {
      return [];
    }
    if (isCodexScaffoldMessage(item.text)) {
      return [];
    }
    const normalized = normalizeCodexTranscriptText(item.text);
    return normalized ? [normalized] : [];
  });

  return chunks.join('\n\n').trim();
}

function buildCodexTranscriptCopyText(
  entries: CodexTranscriptEntry[],
  meta: CodexSessionMetaPayload | null,
  filePath: string,
  translate?: (key: string) => string
): string {
  const t = translate ?? ((key: string) => key);
  const lines = [t('Codex Session Record')];

  if (meta?.id) {
    lines.push(`${t('Session')}: ${meta.id}`);
  }
  if (filePath) {
    lines.push(`${t('File')}: ${filePath}`);
  }

  lines.push('');

  for (const entry of entries) {
    const headerParts = [formatCodexTranscriptEntryTitle(entry, t)];
    if (entry.timestamp) {
      headerParts.push(entry.timestamp);
    }
    lines.push(`[${headerParts.join(' · ')}]`);
    if (entry.detail) {
      lines.push(entry.detail);
    }
    lines.push(formatCodexTranscriptEntryBody(entry, t), '');
  }

  return lines.join('\n').trim();
}

function formatCodexTranscriptEntryTitle(
  entry: CodexTranscriptEntry,
  translate?: (key: string) => string
): string {
  const t = translate ?? ((key: string) => key);

  switch (entry.kind) {
    case 'user':
      return t('User');
    case 'assistant':
      return t('Assistant');
    case 'reasoning':
      return t('Reasoning');
    case 'commentary':
      return t('Commentary');
    case 'tool-output': {
      const prefix = 'Tool Output · ';
      if (entry.title.startsWith(prefix)) {
        return `${t('Tool Output')} · ${entry.title.slice(prefix.length)}`;
      }
      if (entry.title === 'Tool Output') {
        return t('Tool Output');
      }
      return entry.title;
    }
    case 'tool-call': {
      const prefix = 'Tool Call · ';
      if (entry.title.startsWith(prefix)) {
        return `${t('Tool Call')} · ${entry.title.slice(prefix.length)}`;
      }
      if (entry.title === 'Tool Call') {
        return t('Tool Call');
      }
      return entry.title;
    }
    default:
      return entry.title;
  }
}

function formatCodexTranscriptEntryBody(
  entry: CodexTranscriptEntry,
  translate?: (key: string) => string
): string {
  const t = translate ?? ((key: string) => key);
  if (entry.body === 'No arguments.') {
    return t('No arguments.');
  }
  return entry.body;
}

function hasRenderableCodexTranscript(document: CodexTranscriptDocument): boolean {
  return Boolean(document.meta) || document.entries.length > 0;
}

function isCodexTranscriptInvalid(document: CodexTranscriptDocument): boolean {
  return (
    document.diagnostics.nonEmptyLineCount > 0 &&
    document.diagnostics.invalidJsonLineCount > 0 &&
    !hasRenderableCodexTranscript(document)
  );
}

function scoreCodexPromptObservationForTranscript(
  document: CodexTranscriptDocument,
  observations: string[]
): number {
  if (observations.length === 0) {
    return 0;
  }

  const userBodies = document.entries
    .filter((entry) => entry.kind === 'user')
    .map((entry) => normalizeCodexMatchingText(entry.body))
    .filter(Boolean);

  if (userBodies.length === 0) {
    return 0;
  }

  let bestScore = 0;

  observations.forEach((observation, index) => {
    const normalizedObservation = normalizeCodexMatchingText(observation);
    if (!normalizedObservation) {
      return;
    }

    const recencyWeight = Math.max(1, observations.length - index) * 100;
    userBodies.forEach((body, bodyIndex) => {
      let score = 0;
      if (body === normalizedObservation) {
        score = recencyWeight + 60;
      } else if (
        body.startsWith(normalizedObservation) ||
        normalizedObservation.startsWith(body)
      ) {
        score = recencyWeight + 40;
      } else if (
        body.includes(normalizedObservation) ||
        normalizedObservation.includes(body)
      ) {
        score = recencyWeight + 20;
      }

      if (score > 0 && bodyIndex === userBodies.length - 1) {
        score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
      }
    });
  });

  return bestScore;
}

function extractRecentCodexHistoryRecords(
  content: string
): Array<{ sessionId: string; ts?: number }> {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const recent = lines.slice(-MAX_CODEX_HISTORY_LINES).reverse();
  const records: Array<{ sessionId: string; ts?: number }> = [];

  for (const line of recent) {
    try {
      const record = JSON.parse(line) as { session_id?: string; ts?: number };
      if (!record.session_id || records.some((item) => item.sessionId === record.session_id)) {
        continue;
      }
      records.push({ sessionId: record.session_id, ts: record.ts });
    } catch {
      continue;
    }
  }

  return records;
}

async function readLatestCodexHistoryTimestamp(historyPath: string): Promise<number | null> {
  try {
    if (!(await window.electronAPI.file.exists(historyPath))) {
      return null;
    }
    const { content } = await window.electronAPI.file.read(historyPath);
    const latest = extractRecentCodexHistoryRecords(content).find(
      (record) => typeof record.ts === 'number'
    );
    return latest?.ts ?? null;
  } catch {
    return null;
  }
}

function buildCodexSessionDayPaths(
  codexHome: string,
  timestampSeconds?: number
): string[] {
  const baseDate = timestampSeconds ? new Date(timestampSeconds * 1000) : new Date();
  const paths: string[] = [];

  for (const offset of MAX_CODEX_HISTORY_DAY_OFFSETS) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + offset);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const path = joinCodexPath(
      window.electronAPI.env.platform === 'win32' ? '\\' : '/',
      codexHome,
      'sessions',
      year,
      month,
      day
    );
    if (!paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths;
}

async function listCodexDirectorySafely(dirPath: string): Promise<FileEntry[]> {
  try {
    return await window.electronAPI.file.list(dirPath);
  } catch {
    return [];
  }
}

function extractCodexSessionMetaPayload(
  payload: Record<string, unknown>
): CodexSessionMetaPayload | null {
  const metaCandidate =
    'meta' in payload && payload.meta && typeof payload.meta === 'object'
      ? (payload.meta as CodexSessionMetaEnvelopePayload['meta'])
      : payload;

  if (!metaCandidate || typeof metaCandidate !== 'object') {
    return null;
  }

  return {
    id: typeof metaCandidate.id === 'string' ? metaCandidate.id : undefined,
    timestamp:
      typeof metaCandidate.timestamp === 'string' ? metaCandidate.timestamp : undefined,
    cwd: typeof metaCandidate.cwd === 'string' ? metaCandidate.cwd : undefined,
  };
}

function parseCodexTranscriptDocument(
  content: string,
  filePath: string
): CodexTranscriptDocument {
  const entries: CodexTranscriptEntry[] = [];
  let meta: CodexSessionMetaPayload | null = null;
  const diagnostics = {
    nonEmptyLineCount: 0,
    invalidJsonLineCount: 0,
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    diagnostics.nonEmptyLineCount += 1;

    let record: {
      timestamp?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };
    try {
      record = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
    } catch {
      diagnostics.invalidJsonLineCount += 1;
      continue;
    }

    if (record.type === 'session_meta' && record.payload) {
      meta = extractCodexSessionMetaPayload(record.payload);
      continue;
    }

    if (!record.payload) {
      continue;
    }

    const timestamp = formatCodexTimestamp(record.timestamp);
    if (record.type === 'response_item') {
      appendCodexTranscriptEntriesFromResponseItem(entries, record.payload, timestamp);
      continue;
    }

    if (record.type === 'compacted') {
      const replacementHistory = Array.isArray(record.payload.replacement_history)
        ? record.payload.replacement_history
        : [];
      const compactedEntries: CodexTranscriptEntry[] = [];

      replacementHistory.forEach((item) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        appendCodexTranscriptEntriesFromResponseItem(
          compactedEntries,
          item as Record<string, unknown>
        );
      });

      const compactionMessage =
        typeof record.payload.message === 'string'
          ? normalizeCodexTranscriptText(record.payload.message)
          : '';

      entries.length = 0;
      entries.push(...compactedEntries);

      if (entries.length === 0 && compactionMessage) {
        entries.push({
          kind: 'commentary',
          title: 'Commentary',
          body: compactionMessage,
          detail: 'compacted history',
          timestamp,
        });
      }
    }
  }

  return {
    entries,
    copyText: buildCodexTranscriptCopyText(entries, meta, filePath),
    meta,
    diagnostics,
  };
}

function scoreCodexHistoryRecordForSession(
  record: { sessionId: string; ts?: number },
  sessionAnchorTime: number
): number {
  if (!record.ts) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(record.ts * 1000 - sessionAnchorTime);
}

function getCodexTranscriptCandidateTime(
  parsed: CodexTranscriptDocument,
  candidate: FileEntry
): number {
  if (parsed.meta?.timestamp) {
    const parsedTime = Date.parse(parsed.meta.timestamp);
    if (Number.isFinite(parsedTime)) {
      return parsedTime;
    }
  }
  return candidate.modifiedAt;
}

function pickBetterCodexTranscriptCandidate(
  current:
    | {
        entry: FileEntry;
        parsed: CodexTranscriptDocument;
        candidateTime: number;
      }
    | null,
  next: {
    entry: FileEntry;
    parsed: CodexTranscriptDocument;
    candidateTime: number;
  },
  sessionAnchorTime: number
): {
  entry: FileEntry;
  parsed: CodexTranscriptDocument;
  candidateTime: number;
} {
  if (!current) {
    return next;
  }

  const currentDistance = Math.abs(current.candidateTime - sessionAnchorTime);
  const nextDistance = Math.abs(next.candidateTime - sessionAnchorTime);
  if (nextDistance < currentDistance) {
    return next;
  }
  if (nextDistance === currentDistance && next.candidateTime > current.candidateTime) {
    return next;
  }
  return current;
}

function pickBetterCodexTranscriptMatch(
  current:
    | {
        entry: FileEntry;
        parsed: CodexTranscriptDocument;
        candidateTime: number;
        promptScore: number;
        observedSessionIdMatch: boolean;
      }
    | null,
  next: {
    entry: FileEntry;
    parsed: CodexTranscriptDocument;
    candidateTime: number;
    promptScore: number;
    observedSessionIdMatch: boolean;
  },
  sessionAnchorTime: number
): {
  entry: FileEntry;
  parsed: CodexTranscriptDocument;
  candidateTime: number;
  promptScore: number;
  observedSessionIdMatch: boolean;
} {
  if (!current) {
    return next;
  }

  if (next.observedSessionIdMatch !== current.observedSessionIdMatch) {
    return next.observedSessionIdMatch ? next : current;
  }

  if (next.promptScore !== current.promptScore) {
    return next.promptScore > current.promptScore ? next : current;
  }

  const currentDistance = Math.abs(current.candidateTime - sessionAnchorTime);
  const nextDistance = Math.abs(next.candidateTime - sessionAnchorTime);
  if (nextDistance < currentDistance) {
    return next;
  }
  if (nextDistance === currentDistance && next.candidateTime > current.candidateTime) {
    return next;
  }
  return current;
}

export function AgentTerminal({
  id,
  cwd,
  sessionId,
  agentId = 'claude',
  agentCommand = 'claude',
  customPath,
  customArgs,
  environment = 'native',
  initialized,
  activated,
  isActive = false,
  canMerge = false,
  enhancedInputOpen: externalEnhancedInputOpen,
  onEnhancedInputOpenChange,
  onInitialized,
  onActivated,
  onActivatedWithFirstLine,
  onExit,
  onTerminalTitleChange,
  onSplit,
  onMerge,
  onFocus,
  onRegisterEnhancedInputSender,
  onUnregisterEnhancedInputSender,
}: AgentTerminalProps) {
  const { t } = useI18n();
  const baseAgentId = useMemo(() => {
    if (agentId.endsWith('-hapi')) {
      return agentId.slice(0, -5);
    }
    if (agentId.endsWith('-happy')) {
      return agentId.slice(0, -6);
    }
    return agentId;
  }, [agentId]);
  const isCodexAgent = baseAgentId === 'codex';
  const {
    agentNotificationEnabled,
    agentNotificationDelay,
    agentNotificationEnterDelay,
    hapiSettings,
    shellConfig,
    claudeCodeIntegration,
    glowEffectEnabled,
  } = useSettingsStore();

  // Track if hapi is globally installed (cached in main process)
  const [hapiGlobalInstalled, setHapiGlobalInstalled] = useState<boolean | null>(null);

  // Resolved shell for command execution
  const [resolvedShell, setResolvedShell] = useState<{
    shell: string;
    execArgs: string[];
  } | null>(null);

  // Resolve shell configuration on mount and when shellConfig changes
  useEffect(() => {
    window.electronAPI.shell.resolveForCommand(shellConfig).then(setResolvedShell);
  }, [shellConfig]);

  // Check hapi global installation on mount (only for hapi environment)
  useEffect(() => {
    if (environment === 'hapi') {
      window.electronAPI.hapi.checkGlobal(false).then((status) => {
        setHapiGlobalInstalled(status.installed);
      });
    }
  }, [environment]);
  const outputBufferRef = useRef('');
  const startTimeRef = useRef<number | null>(null);
  const hasInitializedRef = useRef(false);
  const hasActivatedRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Delay after Enter before arming idle monitor.
  const isWaitingForIdleRef = useRef(false); // Wait for idle notification; enabled after substantial output.
  const pendingIdleMonitorRef = useRef(false); // Pending idle monitor; enabled after Enter.
  const dataSinceEnterRef = useRef(0); // Track output volume since last Enter.
  const currentTitleRef = useRef<string>(''); // Terminal title from OSC escape sequence.
  const tmuxSessionNameRef = useRef<string | null>(null); // Tmux session name for cleanup.
  const codexSessionStartedAtRef = useRef<number | null>(isCodexAgent ? Date.now() : null);
  const codexTranscriptRequestIdRef = useRef(0);
  const boundCodexSessionRef = useRef<CodexBoundSession | null>(null);
  const codexHistoryBaselineTsRef = useRef<number | null>(null);
  const codexHistoryBaselinePromiseRef = useRef<Promise<number | null> | null>(null);
  const codexObservedSessionIdRef = useRef<string | null>(null);
  const codexOutputProbeBufferRef = useRef('');
  const codexPromptObservationsRef = useRef<string[]>([]);

  // Output state tracking for global store
  const outputStateRef = useRef<OutputState>('idle');
  const isMonitoringOutputRef = useRef(false); // Only monitor after user presses Enter
  const outputSinceEnterRef = useRef(0); // Track output volume since Enter for indicator
  const lastOutputTimeRef = useRef(0); // Track last output timestamp for idle detection
  const activityPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveIdleCountRef = useRef(0); // Count consecutive idle polls
  const ptyIdRef = useRef<string | null>(null); // Store PTY ID for activity checks
  const isActiveRef = useRef(isActive); // Track latest isActive value for interval callback
  const lastCommandWasSlashCommand = useRef(false); // Track if last command was a slash command
  const setOutputState = useAgentSessionsStore((s) => s.setOutputState);
  const markSessionActive = useAgentSessionsStore((s) => s.markSessionActive);
  const clearRuntimeState = useAgentSessionsStore((s) => s.clearRuntimeState);

  const terminalSessionId = id ?? sessionId;
  const resumeSessionId = sessionId ?? id;

  // Use external control if provided, otherwise use local state.
  // IMPORTANT: `externalEnhancedInputOpen` can be false, so we must check `undefined` rather than truthiness.
  const [localEnhancedInputOpen, setLocalEnhancedInputOpen] = useState(false);
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false);
  const [codexTranscriptState, setCodexTranscriptState] = useState<CodexTranscriptState>(
    EMPTY_CODEX_TRANSCRIPT_STATE
  );
  const isExternallyControlled = externalEnhancedInputOpen !== undefined;
  const enhancedInputOpen = isExternallyControlled
    ? externalEnhancedInputOpen
    : localEnhancedInputOpen;
  const setEnhancedInputOpen = useCallback(
    (open: boolean) => {
      if (isExternallyControlled) {
        onEnhancedInputOpenChange?.(open);
        return;
      }
      setLocalEnhancedInputOpen(open);
    },
    [isExternallyControlled, onEnhancedInputOpenChange]
  );

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const resetCodexTranscriptBinding = useCallback(() => {
    codexSessionStartedAtRef.current = Date.now();
    codexTranscriptRequestIdRef.current += 1;
    boundCodexSessionRef.current = null;
    codexHistoryBaselineTsRef.current = null;
    codexObservedSessionIdRef.current = null;
    codexOutputProbeBufferRef.current = '';
    codexPromptObservationsRef.current = [];
    setCodexTranscriptState(EMPTY_CODEX_TRANSCRIPT_STATE);

    const baselinePromise = (async () => {
      const homeDir =
        window.electronAPI.env.HOME || (await window.electronAPI.app.getPath('home'));
      const separator = window.electronAPI.env.platform === 'win32' ? '\\' : '/';
      const historyPath = joinCodexPath(separator, homeDir, '.codex', 'history.jsonl');
      return readLatestCodexHistoryTimestamp(historyPath);
    })();
    codexHistoryBaselinePromiseRef.current = baselinePromise;

    void baselinePromise.then((baselineTs) => {
      if (codexHistoryBaselinePromiseRef.current === baselinePromise) {
        codexHistoryBaselineTsRef.current = baselineTs;
      }
    });
  }, []);

  useEffect(() => {
    if (!isCodexAgent) {
      return;
    }
    resetCodexTranscriptBinding();
    return () => {
      codexHistoryBaselinePromiseRef.current = null;
    };
  }, [isCodexAgent, resetCodexTranscriptBinding]);

  const listRecentCodexSessionFiles = useCallback(async (): Promise<FileEntry[]> => {
    const homeDir = window.electronAPI.env.HOME || (await window.electronAPI.app.getPath('home'));
    const separator = window.electronAPI.env.platform === 'win32' ? '\\' : '/';
    const sessionsRoot = joinCodexPath(separator, homeDir, '.codex', 'sessions');
    const candidateFiles = new Map<string, FileEntry>();
    const visitedDirs = new Set<string>();
    const pendingDirs = [sessionsRoot];

    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir || visitedDirs.has(currentDir)) {
        continue;
      }
      visitedDirs.add(currentDir);

      const entries = await listCodexDirectorySafely(currentDir);
      if (entries.length === 0) {
        continue;
      }

      const directories = entries
        .filter((entry) => entry.isDirectory)
        .sort((a, b) => b.name.localeCompare(a.name));
      pendingDirs.push(...directories.map((entry) => entry.path));

      entries
        .filter((entry) => !entry.isDirectory && entry.name.endsWith('.jsonl'))
        .forEach((entry) => {
          candidateFiles.set(entry.path, entry);
        });
    }

    return [...candidateFiles.values()]
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, MAX_CODEX_SESSION_CANDIDATES);
  }, []);

  const loadCodexTranscript = useCallback(async (): Promise<CodexTranscriptState | null> => {
    if (!isCodexAgent) {
      return null;
    }

    const requestId = ++codexTranscriptRequestIdRef.current;
    setCodexTranscriptState((previous) => ({
      ...previous,
      status: 'loading',
      error: null,
    }));

    try {
      const homeDir =
        window.electronAPI.env.HOME || (await window.electronAPI.app.getPath('home'));
      const separator = window.electronAPI.env.platform === 'win32' ? '\\' : '/';
      const codexHome = joinCodexPath(separator, homeDir, '.codex');
      const sessionsRoot = joinCodexPath(separator, codexHome, 'sessions');
      const historyPath = joinCodexPath(separator, codexHome, 'history.jsonl');
      const sessionAnchorTime =
        startTimeRef.current ?? codexSessionStartedAtRef.current ?? Date.now();
      const historyBaselineTs =
        codexHistoryBaselineTsRef.current ??
        (codexHistoryBaselinePromiseRef.current
          ? await codexHistoryBaselinePromiseRef.current
          : null);
      if (requestId !== codexTranscriptRequestIdRef.current) {
        return null;
      }
      const normalizedCwd = normalizePathForComparison(cwd);
      let boundSession = boundCodexSessionRef.current;
      const observedSessionId = codexObservedSessionIdRef.current;
      const promptObservations = codexPromptObservationsRef.current;
      let invalidBoundSessionPath: string | null = null;
      const commitTranscriptState = (nextState: CodexTranscriptState): CodexTranscriptState => {
        if (requestId === codexTranscriptRequestIdRef.current) {
          setCodexTranscriptState(nextState);
        }
        return nextState;
      };
      const buildEmptyTranscriptState = (): CodexTranscriptState => ({
        ...EMPTY_CODEX_TRANSCRIPT_STATE,
        status: 'ready',
        sessionId: observedSessionId,
      });

      if (
        boundSession &&
        observedSessionId &&
        boundSession.sessionId !== observedSessionId
      ) {
        invalidBoundSessionPath = boundSession.sessionFilePath;
        boundCodexSessionRef.current = null;
        boundSession = null;
      }

      if (boundSession) {
        try {
          const { content } = await window.electronAPI.file.read(boundSession.sessionFilePath);
          if (requestId !== codexTranscriptRequestIdRef.current) {
            return null;
          }

          const parsed = parseCodexTranscriptDocument(content, boundSession.sessionFilePath);
          const parsedCwd = normalizePathForComparison(parsed.meta?.cwd);
          if (normalizedCwd && parsedCwd && parsedCwd !== normalizedCwd) {
            throw new Error(t('Bound Codex session record does not match the current workspace.'));
          }
          if (isCodexTranscriptInvalid(parsed)) {
            throw new Error(t('Failed to load Codex session record.'));
          }

          const nextState: CodexTranscriptState = {
            status: 'ready',
            entries: parsed.entries,
            copyText: buildCodexTranscriptCopyText(
              parsed.entries,
              parsed.meta,
              boundSession.sessionFilePath,
              t
            ),
            error: null,
            sessionId: parsed.meta?.id ?? boundSession.sessionId,
            sessionFilePath: boundSession.sessionFilePath,
            updatedAt:
              formatCodexTimestamp(parsed.meta?.timestamp) ??
              codexTranscriptState.updatedAt ??
              null,
          };

          return commitTranscriptState(nextState);
        } catch {
          invalidBoundSessionPath = boundSession.sessionFilePath;
          boundCodexSessionRef.current = null;
        }
      }

      let recentHistoryRecords: Array<{ sessionId: string; ts?: number }> = [];
      if (await window.electronAPI.file.exists(historyPath)) {
        const { content } = await window.electronAPI.file.read(historyPath);
        recentHistoryRecords = extractRecentCodexHistoryRecords(content).sort((left, right) => {
          const preferredDiff =
            Number(right.sessionId === observedSessionId) -
            Number(left.sessionId === observedSessionId);
          if (preferredDiff !== 0) {
            return preferredDiff;
          }
          const baselineDiff =
            Number(typeof right.ts === 'number' && right.ts > (historyBaselineTs ?? -Infinity)) -
            Number(typeof left.ts === 'number' && left.ts > (historyBaselineTs ?? -Infinity));
          if (baselineDiff !== 0) {
            return baselineDiff;
          }
          const distanceDiff =
            scoreCodexHistoryRecordForSession(left, sessionAnchorTime) -
            scoreCodexHistoryRecordForSession(right, sessionAnchorTime);
          if (distanceDiff !== 0) {
            return distanceDiff;
          }
          return (right.ts ?? 0) - (left.ts ?? 0);
        });
      }

      const recentHistoryRecordsAfterBaseline =
        historyBaselineTs === null
          ? recentHistoryRecords
          : recentHistoryRecords.filter(
              (record) =>
                record.sessionId === observedSessionId ||
                (typeof record.ts === 'number' && record.ts > historyBaselineTs)
            );
      const hasCurrentSessionEvidence =
        observedSessionId !== null || promptObservations.length > 0;
      const shouldAvoidOlderTranscriptFallback =
        historyBaselineTs !== null && hasCurrentSessionEvidence;
      const prioritizedHistoryRecords = shouldAvoidOlderTranscriptFallback
        ? recentHistoryRecordsAfterBaseline
        : recentHistoryRecords;

      if (
        historyBaselineTs !== null &&
        !hasCurrentSessionEvidence &&
        recentHistoryRecordsAfterBaseline.length === 0
      ) {
        return commitTranscriptState(buildEmptyTranscriptState());
      }

      if (
        shouldAvoidOlderTranscriptFallback &&
        recentHistoryRecordsAfterBaseline.length === 0
      ) {
        return commitTranscriptState(buildEmptyTranscriptState());
      }

      let exactMatch:
        | {
            entry: FileEntry;
            parsed: CodexTranscriptDocument;
            candidateTime: number;
            promptScore: number;
            observedSessionIdMatch: boolean;
          }
        | null = null;

      for (const historyRecord of prioritizedHistoryRecords) {
        const dayPaths = buildCodexSessionDayPaths(codexHome, historyRecord.ts);
        let exactCandidate: FileEntry | null = null;

        for (const dayPath of dayPaths) {
          const dayFiles = await listCodexDirectorySafely(dayPath);
          if (dayFiles.length === 0) {
            continue;
          }
          exactCandidate =
            dayFiles.find(
              (candidate) =>
                !candidate.isDirectory &&
                candidate.path !== invalidBoundSessionPath &&
                candidate.path.endsWith(`${historyRecord.sessionId}.jsonl`)
            ) ?? null;
          if (exactCandidate) {
            break;
          }
        }

        if (!exactCandidate) {
          continue;
        }

        try {
          const { content } = await window.electronAPI.file.read(exactCandidate.path);
          if (requestId !== codexTranscriptRequestIdRef.current) {
            return null;
          }

          const parsed = parseCodexTranscriptDocument(content, exactCandidate.path);
          const parsedCwd = normalizePathForComparison(parsed.meta?.cwd);
          if (normalizedCwd && parsedCwd && parsedCwd !== normalizedCwd) {
            continue;
          }
          if (isCodexTranscriptInvalid(parsed)) {
            continue;
          }
          const candidateSessionId = parsed.meta?.id ?? historyRecord.sessionId;
          exactMatch = pickBetterCodexTranscriptMatch(
            exactMatch,
            {
              entry: exactCandidate,
              parsed,
              candidateTime: getCodexTranscriptCandidateTime(parsed, exactCandidate),
              promptScore: scoreCodexPromptObservationForTranscript(parsed, promptObservations),
              observedSessionIdMatch:
                observedSessionId !== null && candidateSessionId === observedSessionId,
            },
            sessionAnchorTime
          );
        } catch {
          continue;
        }
      }

      if (exactMatch) {
        const nextState: CodexTranscriptState = {
          status: 'ready',
          entries: exactMatch.parsed.entries,
          copyText: buildCodexTranscriptCopyText(
            exactMatch.parsed.entries,
            exactMatch.parsed.meta,
            exactMatch.entry.path,
            t
          ),
          error: null,
          sessionId: exactMatch.parsed.meta?.id ?? exactMatch.entry.name.replace(/\.jsonl$/, ''),
          sessionFilePath: exactMatch.entry.path,
          updatedAt:
            formatCodexTimestamp(exactMatch.parsed.meta?.timestamp) ??
            formatCodexTimestamp(new Date(exactMatch.entry.modifiedAt).toISOString()) ??
            null,
        };
        boundCodexSessionRef.current = {
          sessionId: nextState.sessionId ?? exactMatch.entry.name.replace(/\.jsonl$/, ''),
          sessionFilePath: exactMatch.entry.path,
        };

        return commitTranscriptState(nextState);
      }

      const candidates = await listRecentCodexSessionFiles();
      if (requestId !== codexTranscriptRequestIdRef.current) {
        return null;
      }
      if (candidates.length === 0) {
        return commitTranscriptState(buildEmptyTranscriptState());
      }

      let preferredFallbackMatch:
        | {
            entry: FileEntry;
            parsed: CodexTranscriptDocument;
            candidateTime: number;
            promptScore: number;
            observedSessionIdMatch: boolean;
          }
        | null = null;
      let recentFallbackMatch:
        | {
            entry: FileEntry;
            parsed: CodexTranscriptDocument;
            candidateTime: number;
            promptScore: number;
            observedSessionIdMatch: boolean;
          }
        | null = null;
      let fallbackMatch:
        | {
            entry: FileEntry;
            parsed: CodexTranscriptDocument;
            candidateTime: number;
            promptScore: number;
            observedSessionIdMatch: boolean;
          }
        | null = null;

      for (const candidate of candidates) {
        if (candidate.path === invalidBoundSessionPath) {
          continue;
        }
        try {
          const { content } = await window.electronAPI.file.read(candidate.path);
          if (requestId !== codexTranscriptRequestIdRef.current) {
            return null;
          }

          const parsed = parseCodexTranscriptDocument(content, candidate.path);
          const parsedCwd = normalizePathForComparison(parsed.meta?.cwd);
          if (normalizedCwd && parsedCwd !== normalizedCwd) {
            continue;
          }
          if (isCodexTranscriptInvalid(parsed)) {
            continue;
          }

          const candidateTime = getCodexTranscriptCandidateTime(parsed, candidate);
          const candidateSessionId = parsed.meta?.id ?? candidate.name.replace(/\.jsonl$/, '');
          const nextMatch = {
            entry: candidate,
            parsed,
            candidateTime,
            promptScore: scoreCodexPromptObservationForTranscript(parsed, promptObservations),
            observedSessionIdMatch:
              observedSessionId !== null && candidateSessionId === observedSessionId,
          };

          if (observedSessionId && candidate.path.endsWith(`${observedSessionId}.jsonl`)) {
            preferredFallbackMatch = nextMatch;
            break;
          }

          if (historyBaselineTs !== null && candidateTime > historyBaselineTs * 1000) {
            recentFallbackMatch = pickBetterCodexTranscriptMatch(
              recentFallbackMatch,
              nextMatch,
              sessionAnchorTime
            );
          }
          fallbackMatch = pickBetterCodexTranscriptMatch(
            fallbackMatch,
            nextMatch,
            sessionAnchorTime
          );
        } catch {
          continue;
        }
      }

      const selectedFallbackMatch = shouldAvoidOlderTranscriptFallback
        ? preferredFallbackMatch ?? recentFallbackMatch
        : preferredFallbackMatch ?? recentFallbackMatch ?? fallbackMatch;

      if (!selectedFallbackMatch) {
        return commitTranscriptState(buildEmptyTranscriptState());
      }

      const nextState: CodexTranscriptState = {
        status: 'ready',
        entries: selectedFallbackMatch.parsed.entries,
        copyText: buildCodexTranscriptCopyText(
          selectedFallbackMatch.parsed.entries,
          selectedFallbackMatch.parsed.meta,
          selectedFallbackMatch.entry.path,
          t
        ),
        error: null,
        sessionId: selectedFallbackMatch.parsed.meta?.id ?? null,
        sessionFilePath: selectedFallbackMatch.entry.path,
        updatedAt:
          formatCodexTimestamp(selectedFallbackMatch.parsed.meta?.timestamp) ??
          formatCodexTimestamp(new Date(selectedFallbackMatch.entry.modifiedAt).toISOString()) ??
          null,
      };
      boundCodexSessionRef.current = {
        sessionId:
          nextState.sessionId ?? selectedFallbackMatch.entry.name.replace(/\.jsonl$/, ''),
        sessionFilePath: selectedFallbackMatch.entry.path,
      };

      return commitTranscriptState(nextState);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('Failed to load Codex session record.');
      const nextState: CodexTranscriptState = {
        ...EMPTY_CODEX_TRANSCRIPT_STATE,
        status: 'error',
        error: message,
      };

      if (requestId === codexTranscriptRequestIdRef.current) {
        setCodexTranscriptState(nextState);
      }

      return nextState;
    }
  }, [codexTranscriptState.updatedAt, cwd, isCodexAgent, listRecentCodexSessionFiles, t]);

  const openCodexTranscript = useCallback(() => {
    setIsTranscriptOpen(true);
    onFocus?.();
    void loadCodexTranscript();
  }, [loadCodexTranscript, onFocus]);

  const copyCodexTranscript = useCallback(async () => {
    const transcript = await loadCodexTranscript();
    if (!transcript?.copyText) {
      return;
    }
    await navigator.clipboard.writeText(transcript.copyText);
  }, [loadCodexTranscript]);

  // Helper to update output state (with ref tracking to avoid unnecessary store updates)
  const updateOutputState = useCallback(
    (newState: OutputState) => {
      if (!terminalSessionId) return;
      if (outputStateRef.current === newState) return;
      outputStateRef.current = newState;
      // Use isActiveRef.current to get latest value (important for interval callbacks)
      setOutputState(terminalSessionId, newState, isActiveRef.current);

      // Hide enhanced input when agent starts running (hideWhileRunning mode)
      if (
        newState === 'outputting' &&
        agentId === 'claude' &&
        claudeCodeIntegration.enhancedInputEnabled &&
        claudeCodeIntegration.enhancedInputAutoPopup === 'hideWhileRunning'
      ) {
        onEnhancedInputOpenChange?.(false);
      }
    },
    [terminalSessionId, setOutputState, agentId, claudeCodeIntegration, onEnhancedInputOpenChange]
  );

  // Mark session as active when user is viewing it
  useEffect(() => {
    if (isActive && terminalSessionId) {
      markSessionActive(terminalSessionId);
    }
  }, [isActive, terminalSessionId, markSessionActive]);

  // Activity state setter - used by startActivityPolling and handleData/handleCustomKey
  const setActivityState = useWorktreeActivityStore((s) => s.setActivityState);
  const getActivityState = useWorktreeActivityStore((s) => s.getActivityState);

  // Start polling for process activity
  const startActivityPolling = useCallback(() => {
    // Clear any existing interval
    if (activityPollIntervalRef.current) {
      clearInterval(activityPollIntervalRef.current);
    }
    consecutiveIdleCountRef.current = 0;

    activityPollIntervalRef.current = setInterval(async () => {
      if (!ptyIdRef.current || !isMonitoringOutputRef.current) {
        // Stop polling if no PTY or not monitoring
        if (activityPollIntervalRef.current) {
          clearInterval(activityPollIntervalRef.current);
          activityPollIntervalRef.current = null;
        }
        return;
      }

      try {
        const hasProcessActivity = await window.electronAPI.terminal.getActivity(ptyIdRef.current);
        const now = Date.now();
        const hasRecentOutput = now - lastOutputTimeRef.current < RECENT_OUTPUT_TIMEOUT_MS;

        if (hasProcessActivity || hasRecentOutput) {
          // Process is active OR has recent output, reset idle counter
          consecutiveIdleCountRef.current = 0;
          // If we have enough output, show the indicator
          if (outputSinceEnterRef.current > MIN_OUTPUT_FOR_INDICATOR) {
            updateOutputState('outputting');
            // Activity state is now managed by Hook notifications only
          }
        } else {
          // Process is idle AND no recent output
          consecutiveIdleCountRef.current++;
          // Only mark as idle after several consecutive idle polls
          if (consecutiveIdleCountRef.current >= IDLE_CONFIRMATION_COUNT) {
            updateOutputState('idle');
            isMonitoringOutputRef.current = false;

            // Activity state is now managed by Hook notifications only

            // Stop polling when confirmed idle
            if (activityPollIntervalRef.current) {
              clearInterval(activityPollIntervalRef.current);
              activityPollIntervalRef.current = null;
            }
          }
        }
      } catch {
        // Error checking activity, ignore
      }
    }, ACTIVITY_POLL_INTERVAL_MS);
  }, [updateOutputState]);

  // Stop polling for process activity
  const stopActivityPolling = useCallback(() => {
    if (activityPollIntervalRef.current) {
      clearInterval(activityPollIntervalRef.current);
      activityPollIntervalRef.current = null;
    }
  }, []);

  // Cleanup runtime state on unmount
  useEffect(() => {
    return () => {
      if (terminalSessionId) {
        clearRuntimeState(terminalSessionId);
      }
      stopActivityPolling();
    };
  }, [terminalSessionId, clearRuntimeState, stopActivityPolling]);

  // Cleanup tmux session on unmount
  useEffect(() => {
    return () => {
      if (tmuxSessionNameRef.current) {
        window.electronAPI.tmux.killSession(tmuxSessionNameRef.current);
      }
    };
  }, []);

  // Build command with session args
  const { command, env } = useMemo(() => {
    // Wait for shell config to be resolved
    if (!resolvedShell) {
      return { command: undefined, env: undefined };
    }

    // Use custom path if provided, otherwise use agentCommand
    const effectiveCommand = customPath || agentCommand;

    const supportsSession = agentCommand?.startsWith('claude') || agentCommand === 'cursor-agent';
    // Only Claude CLI supports --ide; Cursor CLI does not (errors with "unknown option '--ide'")
    const supportIde = agentCommand?.startsWith('claude');
    const effectiveSessionId = resumeSessionId;

    // Build agent args: cursor-agent and initialized claude use --resume; otherwise --session-id
    let agentArgs: string[] = [];
    if (supportsSession && effectiveSessionId) {
      if (agentCommand === 'cursor-agent' || initialized) {
        agentArgs = ['--resume', effectiveSessionId];
      } else {
        agentArgs = ['--session-id', effectiveSessionId];
      }
    }

    if (supportIde) {
      agentArgs.push('--ide');
    }

    // Append custom args if provided
    if (customArgs) {
      agentArgs.push(customArgs);
    }

    const isWindows = window.electronAPI?.env?.platform === 'win32';
    let envVars: Record<string, string> | undefined;

    // Hapi environment: run through hapi (global) or npx @twsxtd/hapi with CLI_API_TOKEN
    if (environment === 'hapi') {
      // Wait for hapi global check to complete - return undefined to delay terminal init
      if (hapiGlobalInstalled === null) {
        return { command: undefined, env: undefined };
      }

      // Use global 'hapi' command if installed, otherwise use npx
      const hapiPrefix = hapiGlobalInstalled ? 'hapi' : 'npx -y @twsxtd/hapi';
      // claude is default for hapi, so omit agent name for claude
      const hapiArgs = agentCommand?.startsWith('claude') ? '' : effectiveCommand;
      const hapiCommand = `${hapiPrefix} ${hapiArgs} ${agentArgs.join(' ')}`.trim();

      // Pass CLI_API_TOKEN from hapiSettings
      if (hapiSettings.cliApiToken) {
        envVars = { CLI_API_TOKEN: hapiSettings.cliApiToken };
      }

      return {
        command: {
          shell: resolvedShell.shell,
          args: [...resolvedShell.execArgs, hapiCommand],
        },
        env: envVars,
      };
    }

    // Happy environment: run through 'happy' command
    // claude -> happy (claude is default), codex -> happy codex
    if (environment === 'happy') {
      const happyArgs = agentCommand?.startsWith('claude') ? '' : effectiveCommand;
      const happyCommand = `happy ${happyArgs} ${agentArgs.join(' ')}`.trim();

      return {
        command: {
          shell: resolvedShell.shell,
          args: [...resolvedShell.execArgs, happyCommand],
        },
        env: envVars,
      };
    }

    const fullCommand = `${effectiveCommand} ${agentArgs.join(' ')}`.trim();
    const shellName = resolvedShell.shell.toLowerCase();

    // Determine if tmux wrapping should be applied
    const isClaude = agentCommand?.startsWith('claude') ?? false;
    const shouldUseTmux = claudeCodeIntegration.tmuxEnabled && isClaude && !isWindows;

    // Build tmux session name from terminal session ID
    const tmuxSessionName =
      shouldUseTmux && terminalSessionId
        ? `enso-${terminalSessionId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
        : null;
    tmuxSessionNameRef.current = tmuxSessionName;

    // Wrap command in tmux if enabled
    let finalCommand = fullCommand;
    if (tmuxSessionName) {
      const escaped = fullCommand.replace(/'/g, "'\\''");
      finalCommand = `env -u TMUX tmux -L enso -f /dev/null new-session -A -s ${tmuxSessionName} '${escaped}'`;
    }

    // WSL: detect from shell name (wsl.exe)
    if (shellName.includes('wsl') && isWindows) {
      // Use -e to run command directly, sh -lc loads login profile
      // exec $SHELL replaces with user's shell (zsh/bash/etc.)
      const escapedCommand = finalCommand.replace(/"/g, '\\"');
      return {
        command: {
          shell: 'wsl.exe',
          args: ['-e', 'sh', '-lc', `exec "$SHELL" -ilc "${escapedCommand}"`],
        },
        env: envVars,
      };
    }

    // PowerShell: wrap command in script block to preserve argument structure
    // Without this, PowerShell interprets args like --session-id as its own parameters
    if (shellName.includes('powershell') || shellName.includes('pwsh')) {
      return {
        command: {
          shell: resolvedShell.shell,
          args: [...resolvedShell.execArgs, `& { ${finalCommand} }`],
        },
        env: envVars,
      };
    }

    // Native environment: use user's configured shell
    return {
      command: {
        shell: resolvedShell.shell,
        args: [...resolvedShell.execArgs, finalCommand],
      },
      env: envVars,
    };
  }, [
    agentCommand,
    customPath,
    customArgs,
    resumeSessionId,
    initialized,
    environment,
    hapiSettings.cliApiToken,
    hapiGlobalInstalled,
    resolvedShell,
    claudeCodeIntegration.tmuxEnabled,
    terminalSessionId,
  ]);

  // Handle exit with auto-close logic
  const handleExit = useCallback(() => {
    const runtime = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
    const isSessionNotFound = outputBufferRef.current.includes(
      'No conversation found with session ID'
    );

    if (runtime >= MIN_RUNTIME_FOR_AUTO_CLOSE || isSessionNotFound) {
      onExit?.();
    }
    // Quick exit without session error - keep tab open for debugging
  }, [onExit]);

  // Track output for error detection and idle notification
  const handleData = useCallback(
    (data: string) => {
      // Start timer on first data
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }

      if (isCodexAgent) {
        const probeChunk = stripAnsiForCodexProbe(data);
        if (probeChunk) {
          codexOutputProbeBufferRef.current = (
            codexOutputProbeBufferRef.current + probeChunk
          ).slice(-MAX_CODEX_OUTPUT_PROBE_CHARS);
          const observedSessionId = extractCodexSessionIdFromProbe(
            codexOutputProbeBufferRef.current
          );
          if (observedSessionId) {
            codexObservedSessionIdRef.current = observedSessionId;
          }
        }
      }

      // Mark as initialized on first data
      if (!hasInitializedRef.current && !initialized) {
        hasInitializedRef.current = true;
        onInitialized?.();
      }

      // Buffer output for error detection
      outputBufferRef.current += data;
      if (outputBufferRef.current.length > 1000) {
        outputBufferRef.current = outputBufferRef.current.slice(-500);
      }

      // Track output volume since last Enter
      dataSinceEnterRef.current += data.length;

      // === Output state tracking for UI indicator ===
      // Only track when we're monitoring (after user pressed Enter)
      if (isMonitoringOutputRef.current) {
        outputSinceEnterRef.current += data.length;
        lastOutputTimeRef.current = Date.now(); // Track last output time for idle detection

        // Update to 'outputting' once we have substantial output after Enter
        if (outputSinceEnterRef.current > MIN_OUTPUT_FOR_INDICATOR) {
          updateOutputState('outputting');
          // Note: Activity state 'running' is set by handleCustomKey (on Enter) and
          // startActivityPolling (during polling), so no need to set it here
        }
        // Note: The transition to 'idle' is handled by process activity polling
        // (startActivityPolling), not by a simple timeout
      }

      // Only arm idle monitoring after receiving substantial output
      // This prevents notifications from simple prompt echoes
      if (
        pendingIdleMonitorRef.current &&
        dataSinceEnterRef.current > MIN_OUTPUT_FOR_NOTIFICATION
      ) {
        isWaitingForIdleRef.current = true;
        pendingIdleMonitorRef.current = false;
      }

      const stopHookEnabledForSession =
        claudeCodeIntegration.stopHookEnabled && agentCommand.startsWith('claude');

      if (!agentNotificationEnabled || !isWaitingForIdleRef.current || stopHookEnabledForSession)
        return;

      // Clear existing idle timer
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }

      // Set new idle timer - notify when agent stops outputting
      idleTimerRef.current = setTimeout(() => {
        if (isWaitingForIdleRef.current) {
          // Stop waiting after sending the notification, wait for next Enter.
          isWaitingForIdleRef.current = false;
          // Use terminal title as body, fall back to project name.
          const projectName = cwd?.split('/').pop() || 'Unknown';
          const notificationBody = currentTitleRef.current || projectName;
          if (!terminalSessionId) return;
          window.electronAPI.notification.show({
            title: t('{{command}} completed', { command: agentCommand }),
            body: notificationBody,
            sessionId: terminalSessionId,
          });
        }
      }, agentNotificationDelay * 1000);
    },
    [
      initialized,
      onInitialized,
      agentCommand,
      cwd,
      agentNotificationEnabled,
      agentNotificationDelay,
      claudeCodeIntegration.stopHookEnabled,
      isCodexAgent,
      terminalSessionId,
      t,
      updateOutputState,
    ]
  );

  // Handle terminal title changes (OSC escape sequences)
  const handleTitleChange = useCallback(
    (title: string) => {
      currentTitleRef.current = title;
      onTerminalTitleChange?.(title);
    },
    [onTerminalTitleChange]
  );

  // Handle Shift+Enter for newline (Ctrl+J / LF for all agents)
  // Also detect Enter key press to mark session as activated
  // biome-ignore lint/correctness/useExhaustiveDependencies: terminal is accessed via try-catch for safety and defined after this callback
  const handleCustomKey = useCallback(
    (event: KeyboardEvent, ptyId: string, getCurrentLine?: () => string | null) => {
      // Handle Shift+Enter for newline - must be before keydown check to block both keydown and keypress
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown') {
          window.electronAPI.terminal.write(ptyId, '\x0a');
        }
        return false;
      }

      // Only handle keydown events for other logic
      if (event.type !== 'keydown') return true;

      // Handle Ctrl+G to toggle enhanced input (only for Claude)
      if (event.ctrlKey && event.code === 'KeyG' && agentId === 'claude') {
        if (claudeCodeIntegration.enhancedInputEnabled) {
          setEnhancedInputOpen(!enhancedInputOpen);
          return false; // Block the key event only when enhanced input is enabled
        }
        // When enhanced input is disabled, let the event pass through to terminal
      }

      // Detect Enter key press (without modifiers) to activate session and start idle monitoring
      // Skip if IME is composing (e.g. selecting Chinese characters)
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        const submittedLine = getCurrentLine?.()?.trim() ?? '';
        const submittedSlashCommand =
          submittedLine.match(/^\/([^\s]+)/)?.[1]?.toLowerCase() ?? null;

        // First Enter activates the session; optionally pass current line for session name.
        if (!hasActivatedRef.current && !activated) {
          hasActivatedRef.current = true;
          onActivated?.();
          if (getCurrentLine && onActivatedWithFirstLine) {
            if (submittedLine) onActivatedWithFirstLine(submittedLine);
          }
        }
        // Reset output counter.
        dataSinceEnterRef.current = 0;

        // Detect if user entered a slash command (like /clear, /help, etc.)
        // These commands don't trigger Claude and should quickly return to idle
        let isSlashCommand = false;
        if (terminal) {
          try {
            const cursorY = terminal.buffer.active.cursorY;
            const line = terminal.buffer.active.getLine(cursorY);
            if (line) {
              const lineText = line.translateToString().trim();
              isSlashCommand = lineText.startsWith('/');
              lastCommandWasSlashCommand.current = isSlashCommand;
              // Note: slash command detection enables 2s idle timeout for quick return to idle
              if (isSlashCommand) {
                console.log(`[AgentTerminal] Slash command: ${lineText.split(' ')[0]}`);
              }
            }
          } catch {
            // Ignore errors reading terminal buffer
          }
        }

        if (
          isCodexAgent &&
          submittedSlashCommand &&
          ['clear', 'fork', 'new', 'resume'].includes(submittedSlashCommand)
        ) {
          resetCodexTranscriptBinding();
        }

        if (isCodexAgent && submittedLine && !isSlashCommand) {
          codexPromptObservationsRef.current = [
            ...codexPromptObservationsRef.current,
            submittedLine,
          ].slice(-MAX_CODEX_PROMPT_OBSERVATIONS);
        }

        // Activity state is now managed by Hook notifications (PreToolUse, Stop, AskUserQuestion)
        // Enter event no longer sets activity state to avoid conflicts with other terminals

        if (terminalSessionId && glowEffectEnabled) {
          isMonitoringOutputRef.current = true;
          outputSinceEnterRef.current = 0;
          ptyIdRef.current = ptyId;
          startActivityPolling();
        }

        // Clear any existing enter delay timer.
        if (enterDelayTimerRef.current) {
          clearTimeout(enterDelayTimerRef.current);
          enterDelayTimerRef.current = null;
        }
        // If enter delay is configured, wait before arming idle monitor.
        if (agentNotificationEnterDelay > 0) {
          enterDelayTimerRef.current = setTimeout(() => {
            pendingIdleMonitorRef.current = true;
            enterDelayTimerRef.current = null;
          }, agentNotificationEnterDelay * 1000);
        } else {
          // No delay - arm idle monitor immediately.
          pendingIdleMonitorRef.current = true;
        }
        return true; // Let Enter through normally
      }

      // User is typing - cancel idle notification and enter delay timer
      if (
        (isWaitingForIdleRef.current ||
          pendingIdleMonitorRef.current ||
          enterDelayTimerRef.current) &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        isWaitingForIdleRef.current = false;
        pendingIdleMonitorRef.current = false;
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        if (enterDelayTimerRef.current) {
          clearTimeout(enterDelayTimerRef.current);
          enterDelayTimerRef.current = null;
        }
      }

      return true;
    },
    [
      activated,
      onActivated,
      onActivatedWithFirstLine,
      agentNotificationEnterDelay,
      startActivityPolling,
      terminalSessionId,
      glowEffectEnabled,
      cwd,
      setActivityState,
      agentId,
      claudeCodeIntegration.enhancedInputEnabled,
      enhancedInputOpen,
      setEnhancedInputOpen,
      getActivityState,
      isCodexAgent,
      resetCodexTranscriptBinding,
      // Note: terminal is excluded as it's defined after this callback
      // and accessed via try-catch for safety
    ]
  );

  // Wait for shell config and hapi check to complete before activating terminal
  const effectiveIsActive = useMemo(() => {
    if (!resolvedShell) {
      return false;
    }
    if (environment === 'hapi' && hapiGlobalInstalled === null) {
      return false;
    }
    return isActive;
  }, [environment, hapiGlobalInstalled, isActive, resolvedShell]);

  const {
    containerRef,
    isLoading,
    settings,
    findNext,
    findPrevious,
    clearSearch,
    terminal,
    clear,
    refreshRenderer,
    write,
  } = useXterm({
    cwd,
    command,
    env,
    isActive: effectiveIsActive,
    onExit: handleExit,
    onData: handleData,
    onCustomKey: handleCustomKey,
    onTitleChange: handleTitleChange,
    onSplit,
    onMerge,
    canMerge,
  });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchBarRef = useRef<TerminalSearchBarRef>(null);

  // Mirror the side effects that used to live in EnhancedInput.onOpenChange:
  // - Treat opening EnhancedInput as active user interaction (reset idle timers)
  // - Restore terminal focus when EnhancedInput closes so Ctrl+G works without a click
  const prevEnhancedInputOpenRef = useRef(enhancedInputOpen);
  useEffect(() => {
    const prev = prevEnhancedInputOpenRef.current;
    if (prev === enhancedInputOpen) return;
    prevEnhancedInputOpenRef.current = enhancedInputOpen;

    if (enhancedInputOpen) {
      isWaitingForIdleRef.current = false;
      pendingIdleMonitorRef.current = false;

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }

      if (enterDelayTimerRef.current) {
        clearTimeout(enterDelayTimerRef.current);
        enterDelayTimerRef.current = null;
      }
      return;
    }

    requestAnimationFrame(() => terminal?.focus());
  }, [enhancedInputOpen, terminal]);
  const { showScrollToBottom, handleScrollToBottom } = useTerminalScrollToBottom(terminal);

  // Register write and focus functions to global store for external access
  const { register, unregister } = useTerminalWriteStore();
  useEffect(() => {
    if (!terminalSessionId || !write) return;

    register(terminalSessionId, write, () => terminal?.focus());
    return () => unregister(terminalSessionId);
  }, [terminalSessionId, write, terminal, register, unregister]);

  // Handle Cmd+F / Ctrl+F
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyF') {
        e.preventDefault();
        if (isSearchOpen) {
          searchBarRef.current?.focus();
        } else {
          setIsSearchOpen(true);
        }
      }
      // Ctrl+G is now handled in handleCustomKey
    },
    [isSearchOpen]
  );

  // Handle right-click context menu
  const handleContextMenu = useCallback(
    async (e: MouseEvent) => {
      e.preventDefault();
      onFocus?.();

      const menuItems = [
        ...(isCodexAgent
          ? [
              { id: 'history', label: t('View Session') },
              {
                id: 'copy-history',
                label: t('Copy Session'),
              },
              { id: 'separator-history', label: '', type: 'separator' as const },
            ]
          : []),
        { id: 'split', label: t('Split Agent') },
        ...(canMerge ? [{ id: 'merge', label: t('Merge Agent') }] : []),
        { id: 'separator-0', label: '', type: 'separator' as const },
        { id: 'clear', label: t('Clear terminal') },
        { id: 'refresh', label: t('Refresh terminal') },
        { id: 'separator-1', label: '', type: 'separator' as const },
        { id: 'copy', label: t('Copy'), disabled: !terminal?.hasSelection() },
        { id: 'paste', label: t('Paste') },
        { id: 'selectAll', label: t('Select all') },
      ];

      const selectedId = await window.electronAPI.contextMenu.show(menuItems);

      if (!selectedId) return;

      switch (selectedId) {
        case 'history':
          openCodexTranscript();
          break;
        case 'copy-history':
          copyCodexTranscript();
          break;
        case 'split':
          onSplit?.();
          break;
        case 'merge':
          onMerge?.();
          break;
        case 'clear':
          clear();
          break;
        case 'refresh':
          refreshRenderer();
          break;
        case 'copy':
          if (terminal?.hasSelection()) {
            const selection = terminal.getSelection();
            navigator.clipboard.writeText(selection);
          }
          break;
        case 'paste':
          navigator.clipboard.readText().then((text) => {
            terminal?.paste(text);
          });
          break;
        case 'selectAll':
          terminal?.selectAll();
          break;
      }
    },
    [
      terminal,
      clear,
      refreshRenderer,
      t,
      isCodexAgent,
      openCodexTranscript,
      copyCodexTranscript,
      onSplit,
      canMerge,
      onMerge,
      onFocus,
    ]
  );

  useEffect(() => {
    if (!isActive) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, handleKeyDown]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('contextmenu', handleContextMenu);
    return () => container.removeEventListener('contextmenu', handleContextMenu);
  }, [handleContextMenu, containerRef]);

  // Cleanup idle timer on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  // Handle external file drop (from OS file manager, VS Code, etc.)
  const terminalWrapperRef = useFileDrop<HTMLDivElement>({
    cwd,
    onDrop: useCallback(
      (paths: string[]) => {
        if (paths.length > 0 && write) {
          write(paths.map((p) => `@${p}`).join(' '));
          terminal?.focus();
        }
      },
      [write, terminal]
    ),
  });

  // Handle click to activate group
  const handleClick = useCallback(() => {
    if (!isActive) {
      onFocus?.();
    }
  }, [isActive, onFocus]);

  // Handle enhanced input send
  const handleEnhancedInputSend = useCallback(
    async (content: string, imagePaths: string[]) => {
      if (!write || !terminalSessionId) return;

      let message = content;

      if (imagePaths.length > 0) {
        const escapedPaths = imagePaths.map((p) => (p.includes(' ') ? `"${p}"` : p));
        message += `\n\n${escapedPaths.join(' ')}`;
      }

      // For multi-line content (images), write raw bracketed paste markers
      // to PTY directly. Avoids xterm's terminal.paste() which converts
      // \n→\r and breaks multi-image payloads.
      if (isCodexAgent && content.trim()) {
        codexPromptObservationsRef.current = [
          ...codexPromptObservationsRef.current,
          message,
        ].slice(-MAX_CODEX_PROMPT_OBSERVATIONS);
      }

      const hasInternalNewlines = message.includes('\n');
      if (hasInternalNewlines) {
        write(`\x1b[200~${message}\x1b[201~`);
      } else {
        write(message);
      }

      const delay = imagePaths.length > 0 ? 800 : hasInternalNewlines ? 300 : 30;
      setTimeout(() => write('\r'), delay);

      terminal?.focus();
    },
    [isCodexAgent, write, terminalSessionId, terminal]
  );

  useEffect(() => {
    if (!terminalSessionId) return;
    onRegisterEnhancedInputSender?.(terminalSessionId, handleEnhancedInputSend);
    return () => {
      onUnregisterEnhancedInputSender?.(terminalSessionId);
    };
  }, [
    terminalSessionId,
    handleEnhancedInputSend,
    onRegisterEnhancedInputSender,
    onUnregisterEnhancedInputSender,
  ]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click is for focus activation
    <div
      ref={terminalWrapperRef}
      className="relative h-full w-full"
      style={{ backgroundColor: settings.theme.background, contain: 'strict' }}
      onClick={handleClick}
    >
      <div ref={containerRef} className="h-full w-full" />
      <TerminalSearchBar
        ref={searchBarRef}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onFindNext={findNext}
        onFindPrevious={findPrevious}
        onClearSearch={clearSearch}
        theme={settings.theme}
      />
      {isCodexAgent && (
        <CodexViewSessionButton
          containerRef={terminalWrapperRef}
          isTranscriptOpen={isTranscriptOpen}
          onClick={openCodexTranscript}
        />
      )}
      <Dialog open={isTranscriptOpen} onOpenChange={setIsTranscriptOpen}>
        <DialogPopup className="h-[min(80vh,720px)] max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('Codex Session')}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="min-h-0">
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <div>{`${t('Session')}: ${codexTranscriptState.sessionId ?? t('Pending match')}`}</div>
                <div>{`${t('Updated')}: ${codexTranscriptState.updatedAt ?? t('Unknown')}`}</div>
                <div className="truncate">
                  {`${t('File')}: ${codexTranscriptState.sessionFilePath ?? t('Not resolved yet')}`}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60 bg-background/60 p-3">
                {codexTranscriptState.status === 'loading' && (
                  <div className="text-sm text-muted-foreground">
                    {t('Loading Codex session record...')}
                  </div>
                )}

                {codexTranscriptState.status === 'error' && (
                  <div className="text-sm text-destructive">
                    {codexTranscriptState.error ?? t('Failed to load Codex session record.')}
                  </div>
                )}

                {codexTranscriptState.status !== 'loading' &&
                  codexTranscriptState.status !== 'error' &&
                  codexTranscriptState.entries.length === 0 && (
                    <div className="text-sm text-muted-foreground">
                      {t('No readable Codex session record was found yet.')}
                    </div>
                  )}

                {codexTranscriptState.entries.length > 0 && (
                  <div className="flex flex-col gap-3">
                    {codexTranscriptState.entries.map((entry, index) => (
                      <section
                        key={`${entry.kind}-${entry.timestamp ?? 'no-time'}-${index}`}
                        className={`rounded-md border px-3 py-2 ${CODEX_TRANSCRIPT_CARD_STYLES[entry.kind]}`}
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">
                            {formatCodexTranscriptEntryTitle(entry, t)}
                          </div>
                          {entry.timestamp && (
                            <div className="text-[11px] text-muted-foreground">
                              {entry.timestamp}
                            </div>
                          )}
                        </div>
                        {entry.detail && (
                          <div className="mb-2 text-[11px] text-muted-foreground">
                            {entry.detail}
                          </div>
                        )}
                        <pre className="select-text whitespace-pre-wrap break-words font-mono text-xs leading-5">
                          {formatCodexTranscriptEntryBody(entry, t)}
                        </pre>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter variant="bare" className="flex-row justify-between">
            <Button variant="outline" onClick={() => void loadCodexTranscript()}>
              {t('Reload')}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={copyCodexTranscript}>
                {t('Copy')}
              </Button>
              <Button onClick={() => setIsTranscriptOpen(false)}>{t('Close')}</Button>
            </div>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {showScrollToBottom && (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="absolute bottom-12 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary/80 text-primary-foreground shadow-lg transition-all hover:bg-primary hover:scale-105 active:scale-95"
          title={t('Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
      {(isLoading ||
        !resolvedShell ||
        (environment === 'hapi' && hapiGlobalInstalled === null)) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div
              className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent"
              style={{ color: settings.theme.foreground, opacity: 0.5 }}
            />
            <span style={{ color: settings.theme.foreground, opacity: 0.5 }} className="text-sm">
              {t('Loading {{agent}}...', { agent: agentCommand })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
