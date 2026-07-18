import { mkdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLatestCodexSession, getCodexHistory, listCodexSessions } from '../CodexHistoryService';

async function createSessionFile(root: string, filename: string, content: string): Promise<string> {
  const dir = path.join(root, '2026', '07', '17');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('CodexHistoryService', () => {
  it('loads history by session id', async () => {
    const root = path.join(os.tmpdir(), `enso-codex-history-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const sessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-00-${sessionId}.jsonl`,
      JSON.stringify({ role: 'user', content: 'first message' })
    );

    const result = await getCodexHistory({ sessionId, maxMessages: 10, sessionsRoot: root });

    expect(result.sessionId).toBe(sessionId);
    expect(result.messages[0]?.text).toBe('first message');
  });

  it('finds latest session after a timestamp', async () => {
    const root = path.join(os.tmpdir(), `enso-codex-latest-${Date.now()}`);
    const sessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const filePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-00-${sessionId}.jsonl`,
      JSON.stringify({ role: 'user', content: 'new session' })
    );

    const result = await findLatestCodexSession({ sessionsRoot: root, startedAfter: 0 });

    expect(result).toEqual({ sessionId, filePath });
  });

  it('filters latest session by cwd before returning session id', async () => {
    const root = path.join(os.tmpdir(), `enso-codex-cwd-${Date.now()}`);
    const expectedCwd = 'D:/work/current';
    const otherCwd = 'D:/work/other';
    const expectedSessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const otherSessionId = '11996abf-bc87-7e80-9909-3a86a414f7e8';

    const expectedFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-00-${expectedSessionId}.jsonl`,
      JSON.stringify({ type: 'session_meta', payload: { cwd: expectedCwd } })
    );
    const otherFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-01-${otherSessionId}.jsonl`,
      JSON.stringify({ type: 'session_meta', payload: { cwd: otherCwd } })
    );

    const now = Date.now();
    await utimes(expectedFilePath, new Date(now - 10_000), new Date(now - 10_000));
    await utimes(otherFilePath, new Date(now), new Date(now));

    const result = await findLatestCodexSession({
      sessionsRoot: root,
      startedAfter: 0,
      cwd: expectedCwd.replace(/\//g, '\\'),
    });

    expect(result).toEqual({ sessionId: expectedSessionId, filePath: expectedFilePath });
  });

  it('finds new Codex session by creation time instead of modified time', async () => {
    const root = path.join(os.tmpdir(), `enso-codex-created-at-${Date.now()}`);
    const cwd = 'D:/work/current';
    const oldSessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const newSessionId = '11996abf-bc87-7e80-9909-3a86a414f7e8';

    const oldFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-00-${oldSessionId}.jsonl`,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd, timestamp: '2026-07-17T10:00:00.000Z' },
      })
    );
    const newFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-01-00-${newSessionId}.jsonl`,
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd, timestamp: '2026-07-17T10:01:00.000Z' },
      })
    );

    const now = Date.now();
    await utimes(oldFilePath, new Date(now), new Date(now));
    await utimes(newFilePath, new Date(now - 10_000), new Date(now - 10_000));

    const result = await findLatestCodexSession({
      sessionsRoot: root,
      startedAfter: Date.parse('2026-07-17T10:00:30.000Z'),
      cwd: cwd.replace(/\//g, '\\'),
    });

    expect(result).toEqual({ sessionId: newSessionId, filePath: newFilePath });
  });

  it('lists sessions matching cwd sorted by modified time', async () => {
    const root = path.join(os.tmpdir(), `enso-codex-list-${Date.now()}`);
    const expectedCwd = 'D:/work/current';
    const olderSessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const newerSessionId = '21996abf-bc87-7e80-9909-3a86a414f7e8';
    const otherSessionId = '31996abf-bc87-7e80-9909-3a86a414f7e8';

    const olderFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-00-${olderSessionId}.jsonl`,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { cwd: expectedCwd, timestamp: '2026-07-17T10:00:00.000Z' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:/work/current' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Older real task title' }],
          },
        }),
      ].join('\n')
    );
    const newerFilePath = await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-01-${newerSessionId}.jsonl`,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { cwd: expectedCwd, timestamp: '2026-07-17T10:00:01.000Z' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '<environment_context>ignored</environment_context>' },
            ],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review the current code changes' }],
          },
        }),
      ].join('\n')
    );
    await createSessionFile(
      root,
      `rollout-2026-07-17T10-00-02-${otherSessionId}.jsonl`,
      JSON.stringify({ type: 'session_meta', payload: { cwd: 'D:/work/other' } })
    );

    const now = Date.now();
    await utimes(olderFilePath, new Date(now - 10_000), new Date(now - 10_000));
    await utimes(newerFilePath, new Date(now), new Date(now));

    const result = await listCodexSessions({
      sessionsRoot: root,
      cwd: expectedCwd.replace(/\//g, '\\'),
    });

    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      newerSessionId,
      olderSessionId,
    ]);
    expect(result.sessions[0]?.cwd).toBe(expectedCwd);
    expect(result.sessions[0]?.title).toBe('Review the current code changes');
    expect(result.sessions[1]?.title).toBe('Older real task title');
    expect(result.sessions[0]?.timestamp).toBe('2026-07-17T10:00:01.000Z');
  });
});
