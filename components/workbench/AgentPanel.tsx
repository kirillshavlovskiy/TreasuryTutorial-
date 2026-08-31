'use client';

/**
 * AI Agent chat panel — collapsible right-side companion to the Workbench FX
 * desk and the Practice sandbox. Streams chat through /api/agent/chat
 * (Gemini free tier) and lets the model call the desk's VaR / Cash Carry /
 * CFaR engines as tools against a live snapshot of the desk. Advisory only:
 * it never mutates desk state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from 'ai';
import { Loader2, Paperclip, Send, Sparkles, Trash2, X } from 'lucide-react';
import type {
  AttachedDataFile,
  DeskContextSnapshot,
} from '@/lib/agent/desk-context';
import {
  clearAgentChat,
  loadAgentChat,
  saveAgentChat,
} from '@/lib/agent/chat-store';
import { AGENT_FILE_ACCEPT, parseAgentFile } from './agent-files';

const TOOL_LABELS: Record<string, string> = {
  get_desk_state: 'Reading desk state',
  compute_var: 'Running VaR',
  compute_var_for_custom_exposure: 'Running VaR on custom exposure',
  analyze_liquidity: 'Analyzing liquidity path',
  optimize_liquidity_buffer: 'Sizing liquidity buffer',
  analyze_cash_carry: 'Analyzing cash carry',
  optimize_carry_structure: 'Optimizing carry structure',
  compute_cfar: 'Computing CFaR',
  read_uploaded_data: 'Reading attached data',
};

const SUGGESTIONS = [
  'What does my FX risk look like right now?',
  'What liquidity risks do I face next 12 months?',
  'How can I reduce my VaR?',
  'Optimize my hedge carry',
  'What cash reserve does CFaR suggest?',
];

const mdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-2.5 mb-1 text-sm font-semibold tracking-tight text-slate-50 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2.5 mb-1 text-[13px] font-semibold tracking-tight text-slate-50 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-xs font-semibold text-emerald-200 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-1.5 mb-0.5 text-xs font-semibold text-slate-100 first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="my-1.5 text-xs leading-relaxed text-slate-200 first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-4 text-xs text-slate-200">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-4 text-xs text-slate-200">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="leading-relaxed marker:text-slate-500">{children}</li>
  ),
  hr: () => <hr className="my-2.5 border-slate-800" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-50">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-slate-300">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-emerald-300 underline decoration-emerald-800 hover:text-emerald-200"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-emerald-700/70 pl-2.5 text-xs text-slate-300">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const block = Boolean(className);
    if (block) {
      return (
        <code className="block overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-slate-200">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-slate-800 px-1 py-px font-mono text-[11px] text-emerald-300">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-950">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-slate-800">
      <table className="min-w-full border-collapse text-[10px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-slate-800/90 text-slate-100">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-slate-800">{children}</tbody>
  ),
  tr: ({ children }) => <tr className="even:bg-slate-900/50">{children}</tr>,
  th: ({ children }) => (
    <th className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 align-top leading-snug tabular-nums text-slate-200">
      {children}
    </td>
  ),
};

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-md min-w-0 overflow-hidden text-xs leading-relaxed text-slate-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-200">
      {text}
    </div>
  );
}

function ToolChip({
  name,
  state,
}: {
  name: string;
  state: string;
}) {
  const done = state === 'output-available';
  const failed = state === 'output-error';
  const label = TOOL_LABELS[name] ?? name;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
        failed
          ? 'border-rose-700/60 bg-rose-500/10 text-rose-300'
          : done
            ? 'border-emerald-700/60 bg-emerald-500/10 text-emerald-300'
            : 'border-slate-700 bg-slate-800/80 text-slate-300'
      }`}
    >
      {!done && !failed && <Loader2 size={10} className="animate-spin" />}
      {label}
      {done ? ' ✓' : failed ? ' — failed' : '…'}
    </span>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-lg px-3 py-2 ${
          isUser
            ? 'border border-sky-800/60 bg-sky-500/10'
            : 'border border-slate-800 bg-slate-900/80'
        }`}
      >
        <div className="space-y-1.5">
          {message.parts.map((part, i) => {
            if (part.type === 'text') {
              if (!part.text) return null;
              return isUser ? (
                <MessageText key={i} text={part.text} />
              ) : (
                <AssistantMarkdown key={i} text={part.text} />
              );
            }
            if (part.type === 'dynamic-tool') {
              return <ToolChip key={i} name={part.toolName} state={part.state} />;
            }
            if (isToolUIPart(part)) {
              return (
                <ToolChip key={i} name={getToolName(part)} state={part.state} />
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

function friendlyError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  if (/429|quota|RESOURCE_EXHAUSTED|rate/i.test(raw)) {
    return 'Gemini free-tier quota is used up for this model. Wait about a minute and try again.';
  }
  return raw || 'Something went wrong. Try again.';
}

export function AgentPanel({
  deskContext,
  chatScopeId,
  onClose,
}: {
  deskContext: DeskContextSnapshot;
  /** Override localStorage / useChat id (sandbox namespaces away from Workbench). */
  chatScopeId?: string;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<AttachedDataFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Refs so each request ships the snapshot as of send time (the desk keeps
  // changing under the panel) without rebuilding the transport per render.
  const contextRef = useRef(deskContext);
  contextRef.current = deskContext;
  const filesRef = useRef(files);
  filesRef.current = files;

  const scopeId = chatScopeId ?? deskContext.ratesScopeId;
  const initialMessages = useMemo(() => loadAgentChat(scopeId), [scopeId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/agent/chat',
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            messages,
            deskContext: contextRef.current,
            attachedData: filesRef.current,
            ...body,
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, setMessages, status, error } = useChat({
    id: scopeId,
    transport,
    messages: initialMessages,
  });
  const busy = status === 'submitted' || status === 'streaming';
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (status === 'submitted' || status === 'streaming') return;
    saveAgentChat(scopeId, messages);
  }, [messages, status, scopeId]);

  useEffect(
    () => () => {
      saveAgentChat(scopeId, messagesRef.current);
    },
    [scopeId],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setInput('');
  };

  const onPickFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFileError(null);
    for (const file of Array.from(list)) {
      try {
        const parsed = await parseAgentFile(file);
        setFiles(prev => [
          ...prev.filter(f => f.name !== parsed.name),
          parsed,
        ]);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : `Could not read ${file.name}`);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 shadow-xl">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-emerald-400" />
          <div>
            <div className="text-xs font-semibold text-slate-100">AI Agent</div>
            <div className="text-[10px] text-slate-500">
              {deskContext.entityName}
              {deskContext.surface === 'sandbox' ? ' · sandbox' : ''}
              {' · advisory only'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setMessages([]);
                clearAgentChat(scopeId);
              }}
              aria-label="Clear chat history"
              title="Clear chat history"
              className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-300"
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI Agent panel"
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2.5">
            <div className="text-xs leading-relaxed text-slate-200">
              What would you like to optimize — <strong>FX risk (VaR)</strong>,{' '}
              <strong>carry</strong>, or <strong>cash-flow risk (CFaR)</strong>?
              You can also attach a CSV / Excel file with raw exposure or flow
              data and I&apos;ll run it through the desk models.
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-300 hover:border-emerald-700 hover:text-emerald-300"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map(m => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {status === 'submitted' && (
          <div className="flex items-center gap-2 px-1 text-[11px] text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Thinking…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-800/60 bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
            {friendlyError(error.message)}
          </div>
        )}
      </div>

      {(files.length > 0 || fileError) && (
        <div className="border-t border-slate-800 px-3 py-2">
          {fileError && (
            <div className="mb-1.5 text-[10px] text-rose-300">{fileError}</div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {files.map(f => (
              <span
                key={f.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300"
                title={`${f.totalRows} rows · ${f.headers.length} columns`}
              >
                <Paperclip size={9} />
                {f.name}
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles(prev => prev.filter(x => x.name !== f.name))}
                  className="text-slate-500 hover:text-rose-300"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-end gap-1.5 border-t border-slate-800 px-3 py-2.5"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={AGENT_FILE_ACCEPT}
          multiple
          className="hidden"
          onChange={e => void onPickFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach data file"
          title="Attach CSV / Excel data"
          className="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <Paperclip size={14} />
        </button>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={2}
          placeholder="Ask about VaR, carry, CFaR…"
          className="min-w-0 flex-1 resize-none rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-700 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ''}
          aria-label="Send message"
          className="rounded border border-emerald-600/60 bg-emerald-500/20 p-1.5 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </aside>
  );
}

/**
 * Viewport-fixed dock. Portaled to document.body so ancestor overflow-hidden
 * (the FX book table wrapper) cannot clip or cover the toggle.
 */
export function AgentDock({
  deskContext,
  chatScopeId,
}: {
  deskContext: DeskContextSnapshot;
  chatScopeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const panelKey = chatScopeId ?? deskContext.ratesScopeId;

  return createPortal(
    <>
      <div
        className={
          open
            ? 'fixed right-3 top-20 z-[60] h-[calc(100vh-6rem)]'
            : 'hidden'
        }
      >
        <AgentPanel
          key={panelKey}
          deskContext={deskContext}
          chatScopeId={chatScopeId}
          onClose={() => setOpen(false)}
        />
      </div>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Open AI Agent"
          className="fixed right-0 top-32 z-[60] flex flex-col items-center gap-1.5 rounded-l-xl border border-r-0 border-emerald-600/70 bg-slate-950 px-2 py-3 text-emerald-300 shadow-lg hover:border-emerald-400 hover:text-emerald-200"
        >
          <Sparkles size={14} />
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ writingMode: 'vertical-rl' }}
          >
            AI Agent
          </span>
        </button>
      )}
    </>,
    document.body,
  );
}
