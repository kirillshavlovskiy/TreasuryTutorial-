/**
 * Persist Workbench AI Agent chat history in localStorage, keyed by desk
 * scope (entity id / group). Survives panel close and page reload.
 */

import type { UIMessage } from 'ai';

export const AGENT_CHAT_STORAGE_PREFIX = 'ss-agent-chat:v1:';
export const MAX_STORED_MESSAGES = 80;

export function agentChatStorageKey(scopeId: string): string {
  return `${AGENT_CHAT_STORAGE_PREFIX}${scopeId || 'default'}`;
}

/** Isolate sandbox chats from Workbench desks that share the same entity / group id. */
export function sandboxAgentChatScope(taskId: string, ratesScopeId: string): string {
  return `sandbox:${taskId || '01'}:${ratesScopeId || 'default'}`;
}

function isMessage(v: unknown): v is UIMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<UIMessage>;
  return (
    typeof m.id === 'string'
    && (m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    && Array.isArray(m.parts)
  );
}

export function loadAgentChat(scopeId: string): UIMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(agentChatStorageKey(scopeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMessage).slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

export function saveAgentChat(scopeId: string, messages: UIMessage[]): boolean {
  if (typeof window === 'undefined') return false;
  const key = agentChatStorageKey(scopeId);
  const trimmed = messages.slice(-MAX_STORED_MESSAGES);
  try {
    if (trimmed.length === 0) {
      window.localStorage.removeItem(key);
      return true;
    }
    window.localStorage.setItem(key, JSON.stringify(trimmed));
    return true;
  } catch {
    // Quota: drop the oldest half and retry once.
    try {
      const half = trimmed.slice(Math.floor(trimmed.length / 2));
      window.localStorage.setItem(key, JSON.stringify(half));
      return true;
    } catch {
      return false;
    }
  }
}

export function clearAgentChat(scopeId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(agentChatStorageKey(scopeId));
}
