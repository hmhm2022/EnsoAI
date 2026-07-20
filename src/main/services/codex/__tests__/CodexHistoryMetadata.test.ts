import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeCwd, parseCodexSessionMetadata } from '../CodexHistoryMetadata';

const stat = {
  birthtimeMs: Date.parse('2026-07-20T09:00:00.000Z'),
  ctimeMs: Date.parse('2026-07-20T09:00:01.000Z'),
  mtimeMs: Date.parse('2026-07-20T09:00:02.000Z'),
  size: 123,
};

describe('CodexHistoryMetadata', () => {
  it('uses session id from rollout filename first', () => {
    const fileSessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const metaSessionId = '11996abf-bc87-7e80-9909-3a86a414f7e8';
    const filePath = path.join('root', `rollout-2026-07-20T09-00-00-${fileSessionId}.jsonl`);
    const content = JSON.stringify({
      type: 'session_meta',
      payload: { id: metaSessionId, cwd: 'D:/work/current' },
    });

    const metadata = parseCodexSessionMetadata({ filePath, content, fileStat: stat });

    expect(metadata?.sessionId).toBe(fileSessionId);
  });

  it('falls back to session id from meta when filename has no id', () => {
    const sessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const content = JSON.stringify({
      type: 'session_meta',
      payload: { session_id: sessionId, cwd: 'D:/work/current' },
    });

    const metadata = parseCodexSessionMetadata({
      filePath: path.join('root', 'manual.jsonl'),
      content,
      fileStat: stat,
    });

    expect(metadata?.sessionId).toBe(sessionId);
  });

  it('falls back to id only from a session_meta record when filename has no id', () => {
    const sessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const content = JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'D:/work/current' },
    });

    const metadata = parseCodexSessionMetadata({
      filePath: path.join('root', 'manual.jsonl'),
      content,
      fileStat: stat,
    });

    expect(metadata?.sessionId).toBe(sessionId);
  });

  it('does not treat a non-metadata record id as a session id', () => {
    const content = JSON.stringify({
      type: 'response_item',
      payload: { id: 'message-id', role: 'user', content: 'message' },
    });

    const metadata = parseCodexSessionMetadata({
      filePath: path.join('root', 'manual.jsonl'),
      content,
      fileStat: stat,
    });

    expect(metadata).toBeNull();
  });

  it('extracts multiple cwd values, model provider, model, title and timestamp', () => {
    const sessionId = '01996abf-bc87-7e80-9909-3a86a414f7e8';
    const filePath = path.join('root', `rollout-2026-07-20T09-00-00-${sessionId}.jsonl`);
    const content = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: 'D:/work/current',
          timestamp: '2026-07-20T09:00:00.000Z',
          model_provider: 'openai',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd: 'D:/work/secondary', model: 'gpt-5' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '真实用户任务标题' }],
        },
      }),
    ].join('\n');

    const metadata = parseCodexSessionMetadata({ filePath, content, fileStat: stat });

    expect(metadata?.cwdValues).toEqual(['D:/work/current', 'D:/work/secondary']);
    expect(metadata?.cwdNormalizedValues).toEqual(['d:/work/current', 'd:/work/secondary']);
    expect(metadata?.cwd).toBe('D:/work/current');
    expect(metadata?.model).toBe('gpt-5');
    expect(metadata?.modelProvider).toBe('openai');
    expect(metadata?.title).toBe('真实用户任务标题');
    expect(metadata?.timestamp).toBe('2026-07-20T09:00:00.000Z');
    expect(metadata?.createdAtMs).toBe(Date.parse('2026-07-20T09:00:00.000Z'));
    expect(metadata?.modifiedAtMs).toBe(stat.mtimeMs);
  });

  it('normalizes cwd like the current service behavior', () => {
    expect(normalizeCwd('D:\\work\\current\\')).toBe('d:/work/current');
  });
});
