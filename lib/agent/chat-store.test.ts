import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  AGENT_CHAT_STORAGE_PREFIX,
  MAX_STORED_MESSAGES,
  clearAgentChat,
  loadAgentChat,
  sandboxAgentChatScope,
  saveAgentChat,
} from '@/lib/agent/chat-store';
import type { UIMessage } from 'ai';

function msg(id: string, text: string, role: UIMessage['role'] = 'user'): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function stubStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      get keys() {
        return [...store.keys()];
      },
    },
  });
  return store;
}

describe('agent chat store', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips messages for a desk scope', () => {
    const scope = 'ent-corp';
    saveAgentChat(scope, [msg('1', 'hello'), msg('2', 'world', 'assistant')]);
    const loaded = loadAgentChat(scope);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(loadAgentChat('other-desk')).toEqual([]);
  });

  it('caps stored history and drops empty chats', () => {
    const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) =>
      msg(String(i), `m${i}`),
    );
    saveAgentChat('desk', many);
    expect(loadAgentChat('desk')).toHaveLength(MAX_STORED_MESSAGES);
    expect((loadAgentChat('desk')[0]!.parts[0] as { text: string }).text).toBe(
      'm10',
    );

    saveAgentChat('desk', []);
    expect(loadAgentChat('desk')).toEqual([]);
  });

  it('namespaces sandbox chats away from Workbench desk ids', () => {
    const deskId = '__group__';
    expect(sandboxAgentChatScope('01', deskId)).toBe('sandbox:01:__group__');
    expect(sandboxAgentChatScope('practice', deskId)).toBe(
      'sandbox:practice:__group__',
    );
    expect(sandboxAgentChatScope('01', deskId)).not.toBe(deskId);

    saveAgentChat(deskId, [msg('w', 'workbench')]);
    saveAgentChat(sandboxAgentChatScope('01', deskId), [msg('s', 'sandbox')]);
    expect(loadAgentChat(deskId)).toHaveLength(1);
    expect(
      (loadAgentChat(sandboxAgentChatScope('01', deskId))[0]!.parts[0] as { text: string })
        .text,
    ).toBe('sandbox');
  });

  it('ignores corrupt JSON and can be cleared', () => {
    store.set(`${AGENT_CHAT_STORAGE_PREFIX}desk`, '{not json');
    expect(loadAgentChat('desk')).toEqual([]);
    saveAgentChat('desk', [msg('1', 'keep')]);
    clearAgentChat('desk');
    expect(loadAgentChat('desk')).toEqual([]);
  });
});
