'use client';

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  cycleAbsRefToken,
  findLockableRefSpan,
  lexFormula,
} from '@/lib/formula';
import { AVAILABLE_REFS } from '@/lib/sim-formulas';
import {
  formulaEditKey,
  parseFormulaEditKey,
  useFormulaGrid,
} from '@/components/FormulaGrid';
import { colorForName } from '@/lib/token-colors';

const DEFAULT_SUGGESTIONS = [
  ...AVAILABLE_REFS.map(r => r.name),
  'abs', 'min', 'max', 'round', 'sqrt', 'pow', 'floor', 'ceil', 'exp', 'ln', 'log',
];
const OPS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);
const isIdent = (t: string) => /^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(t);
const isNumber = (t: string) => /^[0-9]*\.?[0-9]+$/.test(t);

/** Above portaled modals (z-200) and their backdrops. */
const PORTAL_Z = 'z-[300]';

/** Partial identifier (or `$`) immediately before `caret`. */
function partialIdentAt(
  text: string,
  caret: number,
): { start: number; prefix: string } | null {
  let start = Math.max(0, Math.min(caret, text.length));
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) start -= 1;
  if (start > 0 && text[start - 1] === '$') start -= 1;
  const prefix = text.slice(start, caret);
  if (!prefix) return null;
  if (prefix === '$') return { start, prefix };
  if (!/^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) return null;
  return { start, prefix };
}

function insertAt(
  text: string,
  start: number,
  end: number,
  token: string,
): { next: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needL = before.length > 0 && !/[\s+\-*/%^(),]$/.test(before);
  const needR = after.length > 0 && !/^[\s+\-*/%^(),]/.test(after);
  const piece = `${needL ? ' ' : ''}${token}${needR ? ' ' : ''}`;
  return { next: before + piece + after, caret: before.length + piece.length };
}

/**
 * A table cell whose value comes from a formula. Shows the computed result; a
 * click opens an Excel-like formula bar (free-text, caret anywhere). Committing
 * an empty formula or the default formula clears the override.
 */
export function FormulaCell({
  tdClass,
  display,
  formula,
  defaultFormula,
  onCommit,
  title,
  error,
  suggestions = DEFAULT_SUGGESTIONS,
  columnKey,
  rowKey,
  refToken,
  pickTokenResolver,
  theme = 'light',
  showStoredFormula = false,
  cellAddress,
  evaluateLive,
}: {
  tdClass: string;
  display: ReactNode;
  /** Current override formula (undefined / empty = using default). */
  formula?: string;
  defaultFormula: string;
  onCommit: (text: string) => void;
  title?: string;
  error?: string;
  /** Field / function names offered as autocomplete while typing. */
  suggestions?: string[];
  /** Column identity (e.g. the field key) — enables Excel-like drag-fill down the column. */
  columnKey?: string;
  /** Row identity (e.g. currency code) — enables Excel-like drag-fill down the column. */
  rowKey?: string;
  /**
   * Static ref name inserted when this cell is clicked during another edit
   * (defaults to `columnKey` when set).
   */
  refToken?: string;
  /**
   * Dynamic ref for grids where the token depends on which cell is editing
   * (e.g. forecast M-index cells → `m5`, `rev3`).
   */
  pickTokenResolver?: (active: {
    columnKey: string;
    rowKey: string;
  }) => string | null;
  /** Editor popup skin — use `dark` inside sim-dark modals. */
  theme?: 'light' | 'dark';
  /** When true, show the stored =formula under the computed value. */
  showStoredFormula?: boolean;
  /** Header label in the editor, e.g. `Revenue · M4`. */
  cellAddress?: string;
  /** Live evaluate for the editor result chip; invalid → Save disabled. */
  evaluateLive?: (formula: string) => {
    valid: boolean;
    resultLabel: string;
  };
}) {
  const dark = theme === 'dark';
  const grid = useFormulaGrid();
  const canFill = !!(grid && columnKey && rowKey);
  const editKey =
    columnKey && rowKey ? formulaEditKey(columnKey, rowKey) : null;
  const inDragRange = canFill && grid!.isInDragRange(columnKey!, rowKey!);
  const isDragSource =
    canFill &&
    grid!.dragging?.columnKey === columnKey &&
    grid!.dragging?.sourceRowKey === rowKey;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  /** Selection end (may differ from caret after F4 selects the ref). */
  const [selEnd, setSelEnd] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [previewCoords, setPreviewCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cellRef = useRef<HTMLTableCellElement>(null);
  const draftRef = useRef(draft);
  const caretRef = useRef(caret);
  const selEndRef = useRef(selEnd);
  draftRef.current = draft;
  caretRef.current = caret;
  selEndRef.current = selEnd;
  const insertTokenRef = useRef<(t: string) => void>(() => {});
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const evaluateLiveRef = useRef(evaluateLive);
  evaluateLiveRef.current = evaluateLive;
  /** True while we are closing locally — skip the deactivate-commit effect. */
  const closingRef = useRef(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const resolvePickToken = useCallback((): string | null => {
    if (!grid?.activeEditKey || grid.activeEditKey === editKey) return null;
    const active = parseFormulaEditKey(grid.activeEditKey);
    if (pickTokenResolver) return pickTokenResolver(active);
    if (refToken) return refToken;
    if (columnKey) return columnKey;
    return null;
  }, [grid?.activeEditKey, editKey, pickTokenResolver, refToken, columnKey]);

  const hasOverride = !!(formula && formula.trim());
  const storedFormulaText = hasOverride
    ? formula!.replace(/^=/, '').trim()
    : '';

  const applyDraft = useCallback(
    (next: string, nextCaret: number, nextCaretEnd?: number) => {
      if (!editingRef.current) return;
      const a = Math.max(0, Math.min(nextCaret, next.length));
      const b = Math.max(0, Math.min(nextCaretEnd ?? nextCaret, next.length));
      setDraft(next);
      setCaret(a);
      setSelEnd(b);
      // Restore focus + caret after paint (e.g. after clicking another cell to
      // pick a ref). Avoid a syncing useEffect — that looped with onSelect.
      requestAnimationFrame(() => {
        if (!editingRef.current) return;
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(a, b);
      });
    },
    [],
  );

  const toggleAbsLockAtCaret = useCallback(() => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? caretRef.current;
    const end = el?.selectionEnd ?? start;
    const span = findLockableRefSpan(draftRef.current, start, end);
    if (!span) return;
    const nextTok = cycleAbsRefToken(span.token);
    if (!nextTok) return;
    const next =
      draftRef.current.slice(0, span.start) +
      nextTok +
      draftRef.current.slice(span.end);
    // Keep the ref selected (Excel F4) so repeated F4 keeps cycling.
    applyDraft(next, span.start, span.start + nextTok.length);
  }, [applyDraft]);

  const openEditor = useCallback(
    (anchor: DOMRect) => {
      const editorH = 160;
      const editorW = 320;
      const below = anchor.bottom + 6;
      const above = anchor.top - editorH - 6;
      const top =
        below + editorH > window.innerHeight - 8 && above > 8 ? above : below;
      const left = Math.min(
        Math.max(8, anchor.left),
        Math.max(8, window.innerWidth - editorW - 8),
      );
      closingRef.current = false;
      setCoords({ top, left });
      const src = hasOverride ? storedFormulaText : defaultFormula;
      setDraft(src);
      setCaret(src.length);
      setSelEnd(src.length);
      if (editKey) grid?.beginEdit(editKey);
      setEditing(true);
    },
    [defaultFormula, editKey, grid, hasOverride, storedFormulaText],
  );

  const activateCell = useCallback(
    (e: React.MouseEvent<HTMLTableCellElement>, forceEdit: boolean) => {
      if (
        !forceEdit &&
        grid?.activeEditKey &&
        grid.activeEditKey !== editKey
      ) {
        const token = resolvePickToken();
        if (token && grid.insertRefToken(token)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      openEditor(e.currentTarget.getBoundingClientRect());
    },
    [editKey, grid, openEditor, resolvePickToken],
  );

  const sourceText = hasOverride ? storedFormulaText : defaultFormula;
  const previewTokens = (() => {
    if (!sourceText) return [];
    try {
      return lexFormula(sourceText);
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const pos = Math.max(0, Math.min(caretRef.current, el.value.length));
    el.setSelectionRange(pos, pos);
  }, [editing]);

  // Another cell took the single editor slot → commit this one (Excel-like).
  // Intentionally does NOT depend on onCommit identity (parent inline lambdas
  // would re-fire and can stack with Enter/click-outside commits).
  useEffect(() => {
    if (!editing || !editKey || !grid) return;
    if (grid.activeEditKey === editKey) return;
    if (closingRef.current) return;
    closingRef.current = true;
    const text = draftRef.current.trim();
    setEditing(false);
    setCoords(null);
    setDraft('');
    onCommitRef.current(text);
  }, [editing, editKey, grid, grid?.activeEditKey]);

  // Click outside the editor / cell → commit (unless picking another cell ref).
  useEffect(() => {
    if (!editing) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (editorRef.current?.contains(t)) return;
      if (cellRef.current?.contains(t)) return;
      if (
        t instanceof Element &&
        t.closest('[data-formula-pick]') &&
        grid?.activeEditKey
      ) {
        return;
      }
      if (closingRef.current) return;
      const joined = draftRef.current.trim();
      const live = evaluateLiveRef.current;
      // Invalid formula → discard like Esc (do not write).
      if (live && !live(joined).valid) {
        closingRef.current = true;
        setEditing(false);
        setCoords(null);
        setDraft('');
        if (editKey) grid?.endEdit(editKey);
        return;
      }
      closingRef.current = true;
      setEditing(false);
      setCoords(null);
      setDraft('');
      if (editKey) grid?.endEdit(editKey);
      onCommitRef.current(joined);
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [editing, editKey, grid]);

  const insertToken = useCallback(
    (token: string) => {
      const el = inputRef.current;
      // Focus may already have left the bar (mousedown on a pick cell).
      // Prefer last known caret from state over a blurred input's selection.
      const focused = !!el && document.activeElement === el;
      const start = focused
        ? (el!.selectionStart ?? caretRef.current)
        : caretRef.current;
      const end = focused
        ? (el!.selectionEnd ?? start)
        : selEndRef.current;
      const { next, caret: nextCaret } = insertAt(
        draftRef.current,
        start,
        end,
        token,
      );
      applyDraft(next, nextCaret);
    },
    [applyDraft],
  );
  insertTokenRef.current = insertToken;

  useEffect(() => {
    if (!editing || !editKey || !grid) return;
    const inserter = (token: string) => insertTokenRef.current(token);
    grid.registerRefInserter(editKey, inserter);
    return () => grid.unregisterRefInserter(editKey);
  }, [editing, editKey, grid]);

  const handleCellClick = (e: React.MouseEvent<HTMLTableCellElement>) => {
    // Second click of a double-click has detail >= 2 — wait for onDoubleClick.
    if (e.detail >= 2) return;
    activateCell(e, false);
  };

  const handleCellDoubleClick = (e: React.MouseEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    e.stopPropagation();
    activateCell(e, true);
  };

  const close = (opts?: { clearDraft?: boolean }) => {
    closingRef.current = true;
    setEditing(false);
    setCoords(null);
    if (opts?.clearDraft !== false) setDraft('');
    if (editKey) grid?.endEdit(editKey);
  };
  const commit = () => {
    if (closingRef.current && !editing) return;
    const text = draftRef.current.trim();
    close();
    onCommitRef.current(text);
  };

  const handleInputChange = (raw: string, selStart: number | null) => {
    const caretAt = selStart ?? raw.length;
    let cleaned = '';
    let nextCaret = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      // ALLOWED matches disallowed chars.
      if (/[^A-Za-z0-9_$.+\-*/%^(), ]/.test(ch)) continue;
      cleaned += ch;
      if (i < caretAt) nextCaret += 1;
    }
    setDraft(cleaned);
    setCaret(nextCaret);
    setSelEnd(nextCaret);
  };

  const partial = partialIdentAt(draft, caret);
  const matches =
    partial && isIdent(partial.prefix)
      ? suggestions
          .filter(
            s =>
              s.toLowerCase().startsWith(partial.prefix.toLowerCase()) &&
              s.toLowerCase() !== partial.prefix.toLowerCase(),
          )
          .slice(0, 6)
      : partial?.prefix === '$'
        ? suggestions.filter(s => s.startsWith('$')).slice(0, 6)
        : [];

  const liveFormula = draft.trim();

  // Only evaluate while the editor is open — avoids work on every grid re-render.
  const liveEval =
    editing && evaluateLive
      ? evaluateLive(liveFormula)
      : {
          valid: true,
          resultLabel:
            typeof display === 'string' || typeof display === 'number'
              ? String(display)
              : '—',
        };
  const formulaInvalid = editing && evaluateLive != null && !liveEval.valid;

  const editorShell = dark
    ? `${PORTAL_Z} sim-dark w-[320px] max-w-[320px] rounded-lg border bg-slate-900 p-2.5 shadow-2xl shadow-black/60 ${
        formulaInvalid
          ? 'border-rose-500/70 ring-1 ring-rose-500/30'
          : 'border-slate-600 ring-1 ring-sky-500/40'
      }`
    : `${PORTAL_Z} w-[320px] max-w-[320px] rounded-lg border bg-white p-2 shadow-xl ${
        formulaInvalid ? 'border-rose-400' : 'border-blue-400'
      }`;

  const suggestionBtn = dark
    ? 'rounded-md border border-slate-700 bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-300 hover:border-sky-600/50 hover:bg-sky-950/40 hover:text-sky-200'
    : 'rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 hover:bg-blue-100 hover:text-blue-800';

  const editorHint = dark ? 'text-slate-500' : 'text-gray-400';

  const editingCellClass = dark
    ? 'relative z-[1] ring-1 ring-inset ring-sky-500'
    : 'relative z-[1] ring-1 ring-inset ring-blue-500';

  const quickInsert = ['prev', 'm1', '$m1', 'exp()'] as const;

  const startFill = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canFill) return;
    const formulaText = hasOverride
      ? `=${storedFormulaText}`
      : `=${defaultFormula}`;
    const rect = cellRef.current?.getBoundingClientRect();
    const origin = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: e.clientX, y: e.clientY };
    grid!.beginDrag(columnKey!, rowKey!, formulaText, origin);
  };

  const startEditorWindowDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    // Don't start window-drag from interactive controls inside the header.
    if (t?.closest('button, input, textarea, a')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = coords ?? { top: 0, left: 0 };
    const onMove = (ev: MouseEvent) => {
      const nextTop = Math.min(
        Math.max(8, orig.top + (ev.clientY - startY)),
        window.innerHeight - 48,
      );
      const nextLeft = Math.min(
        Math.max(8, orig.left + (ev.clientX - startX)),
        window.innerWidth - 48,
      );
      setCoords({ top: nextTop, left: nextLeft });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (editing && coords) {
    const address =
      cellAddress ??
      [columnKey, rowKey != null && /^\d+$/.test(rowKey)
        ? `M${Number(rowKey) + 1}`
        : rowKey]
        .filter(Boolean)
        .join(' · ');
    const editor = (
      <div
        ref={editorRef}
        className={editorShell}
        style={{ top: coords.top, left: coords.left, position: 'fixed' }}
        onMouseDown={e => {
          // Keep focus in the formula bar when clicking chrome/buttons,
          // but never block caret placement inside the input itself.
          const t = e.target as HTMLElement | null;
          if (t?.closest('input, textarea')) return;
          e.preventDefault();
        }}
        role="dialog"
        aria-label="Formula editor"
      >
        <div
          className={`mb-1.5 flex cursor-grab items-center justify-between gap-2 active:cursor-grabbing ${
            dark ? 'text-slate-300' : 'text-gray-700'
          }`}
          onMouseDown={startEditorWindowDrag}
          title="Drag to move"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`shrink-0 text-[9px] tracking-widest ${editorHint}`}
              aria-hidden
            >
              ∷
            </span>
            <div className="min-w-0 truncate font-mono text-[10px]">
              {address || 'Formula'}
            </div>
          </div>
          <span className={`shrink-0 text-[9px] ${editorHint}`}>
            was {typeof display === 'string' || typeof display === 'number'
              ? display
              : '—'}
          </span>
        </div>

        <div
          className={`flex items-center gap-1 rounded-md border px-1.5 py-1 ${
            formulaInvalid
              ? dark
                ? 'border-rose-500/60 bg-rose-950/30'
                : 'border-rose-400 bg-rose-50'
              : dark
                ? 'border-slate-700 bg-slate-950/80'
                : 'border-gray-200 bg-gray-50'
          }`}
        >
          <span
            className={`font-mono text-xs font-bold ${dark ? 'text-sky-400' : 'text-blue-500'}`}
          >
            =
          </span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            spellCheck={false}
            onChange={e =>
              handleInputChange(e.target.value, e.target.selectionStart)
            }
            onSelect={e => {
              const el = e.currentTarget;
              setCaret(el.selectionStart ?? el.value.length);
              setSelEnd(el.selectionEnd ?? el.selectionStart ?? el.value.length);
            }}
            onKeyUp={e => {
              const el = e.currentTarget;
              setCaret(el.selectionStart ?? el.value.length);
              setSelEnd(el.selectionEnd ?? el.selectionStart ?? el.value.length);
            }}
            onClick={e => {
              const el = e.currentTarget;
              setCaret(el.selectionStart ?? el.value.length);
              setSelEnd(el.selectionEnd ?? el.selectionStart ?? el.value.length);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!formulaInvalid) commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'F4') {
                e.preventDefault();
                toggleAbsLockAtCaret();
              } else if (e.key === 'Tab' && matches.length && partial) {
                e.preventDefault();
                const pick = matches[0]!;
                const replaced =
                  draft.slice(0, partial.start) + pick + draft.slice(caret);
                applyDraft(replaced, partial.start + pick.length);
              }
            }}
            className={`min-w-0 flex-1 bg-transparent px-0.5 font-mono text-[11px] outline-none ${
              dark ? 'text-sky-100' : 'text-gray-900'
            }`}
            placeholder="prev * m1 · F4 or $ locks"
            title="Type $ before a ref (e.g. $m1) or press F4 to toggle absolute lock — locked refs do not shift when filling across months"
          />
          <span
            className={`shrink-0 font-mono text-[11px] tabular-nums ${
              formulaInvalid
                ? dark
                  ? 'text-rose-300'
                  : 'text-rose-600'
                : dark
                  ? 'text-emerald-300'
                  : 'text-emerald-700'
            }`}
            title="Evaluated result"
          >
            {liveEval.resultLabel}
          </span>
        </div>

        <div
          className={`mt-1.5 flex flex-wrap gap-1 border-t pt-1.5 ${
            dark ? 'border-slate-800' : 'border-gray-100'
          }`}
        >
          {(matches.length > 0 ? matches : [...quickInsert]).map(m => (
            <button
              key={m}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (partial && matches.includes(m)) {
                  const replaced =
                    draft.slice(0, partial.start) + m + draft.slice(caret);
                  applyDraft(replaced, partial.start + m.length);
                  return;
                }
                insertToken(m === 'exp()' ? 'exp' : m);
              }}
              className={suggestionBtn}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className={`text-[9px] leading-snug ${editorHint}`}>
            <span className="rounded border border-slate-700 px-1">F4</span>
            {' / '}
            <span className="font-mono">$</span> lock ·{' '}
            <span className="rounded border border-slate-700 px-1">Enter</span>{' '}
            save ·{' '}
            <span className="rounded border border-slate-700 px-1">Esc</span>{' '}
            cancel
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => close()}
              className={
                dark
                  ? 'rounded-md border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800'
                  : 'rounded border border-gray-300 px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => commit()}
              disabled={formulaInvalid}
              className={
                dark
                  ? 'rounded-md border border-sky-500 bg-sky-600/30 px-2.5 py-0.5 text-[10px] font-semibold text-sky-100 hover:bg-sky-600/45 disabled:cursor-not-allowed disabled:opacity-40'
                  : 'rounded border border-blue-500 bg-blue-600 px-2.5 py-0.5 text-[10px] font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40'
              }
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
    return (
      <td
        ref={cellRef}
        className={`${tdClass} ${editingCellClass}`}
        data-formula-col={columnKey ?? undefined}
        data-formula-row={rowKey ?? undefined}
      >
        {/* Keep the computed value visible — do not replace with =formula. */}
        <div className="flex min-h-[20px] items-center justify-end py-0.5 font-mono tabular-nums">
          {display}
        </div>
        {typeof document !== 'undefined' &&
          createPortal(editor, document.body)}
      </td>
    );
  }

  const tip = error
    ? `Formula error: ${error}`
    : hasOverride
      ? `= ${storedFormulaText}  ·  click / double-click to edit${canFill ? ' · drag corner to fill (relative refs shift)' : ''}`
      : `${title ? title + ' · ' : ''}= ${defaultFormula || '(model value)'}  ·  click / double-click to edit${canFill ? ' · drag corner to fill (relative refs shift)' : ''}`;

  const showPreview =
    !!previewCoords && !grid?.dragging && !!previewTokens && previewTokens.length > 0;

  const dragHighlight = dark
    ? 'outline outline-2 outline-sky-400 outline-offset-[-1px] bg-sky-950/50'
    : 'outline outline-2 outline-blue-400 outline-offset-[-1px] bg-blue-50/60';

  const pickToken = resolvePickToken();
  const pickableClass = pickToken
    ? dark
      ? 'cursor-cell ring-1 ring-inset ring-sky-500/35 hover:bg-sky-500/10'
      : 'cursor-cell ring-1 ring-inset ring-blue-400/40 hover:bg-blue-50/90'
    : '';

  return (
    <td
      ref={cellRef}
      className={`${tdClass} relative cursor-pointer group ${error ? 'ring-1 ring-red-400' : ''} ${
        inDragRange ? dragHighlight : ''
      } ${pickableClass}`}
      data-formula-col={columnKey ?? undefined}
      data-formula-row={rowKey ?? undefined}
      {...(pickToken ? { 'data-formula-pick': pickToken } : {})}
      title={tip}
      onMouseDown={e => {
        // Keep formula-bar focus when this cell is only a ref pick target.
        if (pickToken) e.preventDefault();
      }}
      onClick={handleCellClick}
      onDoubleClick={handleCellDoubleClick}
      onMouseEnter={e => {
        // Fill range is driven by window pointermove (axis-locked); mouseEnter
        // remains a lightweight fallback when still over the same column.
        if (canFill) grid!.hoverDrag(columnKey!, rowKey!);
        // Avoid stacking formula previews while another cell is being edited.
        if (grid?.activeEditKey) return;
        if (grid?.dragging) return;
        const rect = e.currentTarget.getBoundingClientRect();
        setPreviewCoords({ top: rect.bottom + 2, left: rect.left });
      }}
      onMouseLeave={() => setPreviewCoords(null)}
    >
      <div className="flex min-h-[20px] flex-col items-end gap-0.5 py-0.5">
        <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
          {hasOverride && !error && (
            <span
              className={`text-[9px] font-bold ${dark ? 'text-sky-400' : 'text-sky-600'}`}
              aria-hidden
            >
              ƒ
            </span>
          )}
          {error ? (
            <span className="text-red-500">#ERR</span>
          ) : (
            display
          )}
        </span>
        {showStoredFormula && hasOverride && !error && (
          <span
            className={`max-w-full truncate font-mono text-[9px] ${dark ? 'text-sky-300/80' : 'text-sky-700'}`}
            title={`Stored: =${storedFormulaText}`}
          >
            ={storedFormulaText}
          </span>
        )}
      </div>
      {canFill && (
        <span
          onMouseDown={startFill}
          title="Drag to fill formula across cells (relative month refs shift)"
          className={`absolute bottom-0 right-0 z-10 h-1.5 w-1.5 cursor-crosshair bg-sky-500 opacity-60 group-hover:opacity-100 ${
            isDragSource ? 'opacity-100' : ''
          }`}
          aria-hidden
        />
      )}
      {showPreview &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className={`fixed ${PORTAL_Z} flex max-w-[320px] flex-wrap items-center gap-1 rounded-lg border p-1.5 shadow-lg pointer-events-none ${
              dark
                ? 'sim-dark border-slate-600 bg-slate-900 ring-1 ring-slate-700/80'
                : 'border-gray-200 bg-white'
            }`}
            style={{ top: previewCoords!.top, left: previewCoords!.left }}
          >
            <span
              className={`font-mono text-xs font-bold ${dark ? 'text-slate-500' : 'text-gray-400'}`}
            >
              =
            </span>
            {previewTokens!.map((t, i) =>
              OPS.has(t) ? (
                <span
                  key={i}
                  className={`px-0.5 font-mono text-xs ${dark ? 'text-slate-400' : 'text-gray-500'}`}
                >
                  {t}
                </span>
              ) : (
                <span
                  key={i}
                  className={`rounded px-1 py-0.5 text-[11px] font-medium ${
                    isNumber(t)
                      ? dark
                        ? 'bg-amber-950/70 text-amber-200'
                        : 'bg-amber-100 text-amber-800'
                      : `${colorForName(t).bg} ${colorForName(t).text}`
                  }`}
                >
                  {t}
                </span>
              ),
            )}
            {!hasOverride && (
              <span
                className={`ml-1 text-[9px] ${dark ? 'text-slate-500' : 'text-gray-400'}`}
              >
                (default)
              </span>
            )}
          </div>,
          document.body,
        )}
    </td>
  );
}
