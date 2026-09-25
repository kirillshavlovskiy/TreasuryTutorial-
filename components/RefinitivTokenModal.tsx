'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  REFINITIV_TOKEN_EXPIRED_EVENT,
  readSessionRefinitivToken,
  stripRefinitivBearer,
  writeSessionRefinitivToken,
} from '@/lib/refinitivPriceClient';

const DEFAULT_REASON =
  'Paste a Refinitiv Bearer to pull IPA curves, spots, and vol surfaces. Open this from Market data → Paste token.';

export function RefinitivTokenGate() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [hint, setHint] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
    const onExpired = (event: Event) => {
      const detail =
        event instanceof CustomEvent && typeof event.detail === 'string'
          ? event.detail.trim()
          : '';
      setReason(detail || DEFAULT_REASON);
      setDraft(readSessionRefinitivToken());
      setHint(null);
      setOpen(true);
    };
    window.addEventListener(REFINITIV_TOKEN_EXPIRED_EVENT, onExpired);
    return () => {
      window.removeEventListener(REFINITIV_TOKEN_EXPIRED_EVENT, onExpired);
    };
  }, []);

  if (!ready || !open || typeof document === 'undefined') return null;

  const save = () => {
    const token = stripRefinitivBearer(draft);
    if (!token) {
      setHint('Paste a Bearer token.');
      return;
    }
    writeSessionRefinitivToken(token);
    setOpen(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="refinitiv-token-title"
      onClick={e => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-amber-200/80">
          Refinitiv IPA
        </div>
        <h2
          id="refinitiv-token-title"
          className="mt-1 text-sm font-semibold text-slate-100"
        >
          Paste Bearer token
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          {reason}
        </p>
        <label className="mt-3 block">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-slate-500">
            Bearer token
          </span>
          <textarea
            autoFocus
            spellCheck={false}
            autoComplete="off"
            rows={4}
            value={draft}
            onChange={ev => {
              setDraft(ev.target.value);
              setHint(null);
            }}
            onKeyDown={ev => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) save();
              if (ev.key === 'Escape') setOpen(false);
            }}
            placeholder="Paste Bearer eyJ… or the raw JWT"
            className="mt-1 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2.5 py-2 font-mono text-[11px] text-slate-200 outline-none focus:border-sky-500"
          />
        </label>
        {hint && <p className="mt-2 text-[11px] text-rose-300">{hint}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-[30px] rounded-md border border-slate-700 px-3 text-[11px] font-medium text-slate-300 hover:border-slate-500 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="h-[30px] rounded-md border border-sky-600 bg-sky-700 px-3.5 text-[11px] font-semibold text-sky-50 hover:bg-sky-600"
          >
            Use this token
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
