'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { lexFormula } from '@/lib/formula';
import { AVAILABLE_REFS } from '@/lib/sim-formulas';
import { useFormulaGrid } from '@/components/FormulaGrid';
import { colorForName } from '@/lib/token-colors';

const DEFAULT_SUGGESTIONS = [
  ...AVAILABLE_REFS.map(r => r.name),
  'abs', 'min', 'max', 'round', 'sqrt', 'pow', 'floor', 'ceil',
];
const OPS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',']);
const ALLOWED = /[^A-Za-z0-9_.+\-*/%^(), ]/g;
const isIdent = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
const isNumber = (t: string) => /^[0-9]*\.?[0-9]+$/.test(t);

/**
 * A table cell whose value comes from a formula. Shows the computed result; a
 * click opens an Excel-like formula editor where each variable / number is a
 * removable chip (Backspace deletes a whole token, not one letter). Committing
 * an empty formula or the default formula clears the override.
 */
export function FormulaCell({
  tdClass, display, formula, defaultFormula, onCommit, title, error, suggestions = DEFAULT_SUGGESTIONS,
  columnKey, rowKey,
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
}) {
  const grid = useFormulaGrid();
  const canFill = !!(grid && columnKey && rowKey);
  const inDragRange = canFill && grid!.isInDragRange(columnKey!, rowKey!);
  const isDragSource = canFill && grid!.dragging?.columnKey === columnKey && grid!.dragging?.sourceRowKey === rowKey;
  const [editing, setEditing] = useState(false);
  const [tokens, setTokens] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [previewCoords, setPreviewCoords] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasOverride = !!(formula && formula.trim());

  const sourceText = hasOverride ? formula!.replace(/^=/, '').trim() : defaultFormula;
  const previewTokens = (() => {
    if (!sourceText) return [];
    try { return lexFormula(sourceText); } catch { return null; }
  })();

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = (e: React.MouseEvent<HTMLTableCellElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCoords({ top: rect.bottom + 2, left: rect.left });
    const src = hasOverride ? formula!.replace(/^=/, '') : defaultFormula;
    let lexed: string[] = [];
    try { lexed = src ? lexFormula(src) : []; } catch { lexed = []; }
    setTokens(lexed);
    setInput('');
    setEditing(true);
  };

  const close = () => { setEditing(false); setCoords(null); };
  const commit = () => {
    const all = [...tokens, input.trim()].filter(Boolean);
    close();
    onCommit(all.join(' '));
  };

  // Move any completed lexemes out of the typing buffer and into chips.
  const handleInput = (raw: string) => {
    const cleaned = raw.replace(ALLOWED, '');
    let lexemes: string[];
    try { lexemes = lexFormula(cleaned); } catch { setInput(cleaned); return; }
    if (lexemes.length === 0) { setInput(''); return; }
    const endsWithSpace = /\s$/.test(cleaned);
    const last = lexemes[lexemes.length - 1];
    let remainder = '';
    let newTokens = lexemes;
    if (!endsWithSpace && (isIdent(last) || isNumber(last))) {
      remainder = last;
      newTokens = lexemes.slice(0, -1);
    }
    if (newTokens.length) setTokens(prev => [...prev, ...newTokens]);
    setInput(remainder);
  };

  const addToken = (t: string) => { setTokens(prev => [...prev, t]); setInput(''); inputRef.current?.focus(); };
  const removeToken = (i: number) => { setTokens(prev => prev.filter((_, idx) => idx !== i)); inputRef.current?.focus(); };

  const matches = isIdent(input)
    ? suggestions.filter(s => s.toLowerCase().startsWith(input.toLowerCase()) && s.toLowerCase() !== input.toLowerCase()).slice(0, 6)
    : [];

  if (editing && coords) {
    const editor = (
      <div
        className="fixed z-[100] min-w-[260px] max-w-[360px] rounded-md border border-blue-400 bg-white p-1.5 shadow-xl"
        style={{ top: coords.top, left: coords.left }}
      >
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-mono text-xs font-bold text-blue-500">=</span>
          {tokens.map((t, i) =>
            OPS.has(t) ? (
              <span key={i} className="px-0.5 font-mono text-xs text-gray-500">{t}</span>
            ) : (
              <span
                key={i}
                className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium ${
                  isNumber(t) ? 'bg-amber-100 text-amber-800' : `${colorForName(t).bg} ${colorForName(t).text}`
                }`}
              >
                {t}
                <button
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => removeToken(i)}
                  className="leading-none text-current opacity-50 hover:opacity-100"
                  aria-label={`Remove ${t}`}
                >×</button>
              </span>
            ),
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            spellCheck={false}
            onChange={e => handleInput(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); close(); }
              else if (e.key === 'Tab' && matches.length) { e.preventDefault(); addToken(matches[0]); }
              else if (e.key === 'Backspace' && input === '' && tokens.length) { e.preventDefault(); removeToken(tokens.length - 1); }
            }}
            className={`min-w-[48px] flex-1 rounded px-1 py-0.5 font-mono text-[11px] outline-none ${
              isNumber(input) ? 'bg-amber-100 text-amber-800'
                : isIdent(input) ? `${colorForName(input).bg} ${colorForName(input).text}`
                : 'bg-transparent text-gray-900'
            }`}
            placeholder={tokens.length ? '' : 'type a formula…'}
          />
        </div>

        {matches.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1 border-t border-gray-100 pt-1">
            {matches.map(m => (
              <button
                key={m}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => addToken(m)}
                className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 hover:bg-blue-100 hover:text-blue-800"
              >{m}</button>
            ))}
          </div>
        )}

        <div className="mt-1 text-[9px] text-gray-400">
          Enter apply · Esc cancel · ⌫ deletes a token · Tab accepts suggestion
        </div>
      </div>
    );
    return (
      <td className={tdClass}>
        <span className="inline-flex items-center gap-0.5 opacity-60">{display}</span>
        {typeof document !== 'undefined' && createPortal(editor, document.body)}
      </td>
    );
  }

  const tip = error
    ? `Formula error: ${error}`
    : hasOverride
      ? `= ${formula!.replace(/^=/, '').trim()}  ·  click to edit${canFill ? ' · drag the corner handle to copy down the column' : ''}`
      : `${title ? title + ' · ' : ''}= ${defaultFormula || '(model value)'}  ·  click to edit${canFill ? ' · drag the corner handle to copy down the column' : ''}`;

  const startFill = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canFill) return;
    const formulaText = hasOverride ? `=${formula!.replace(/^=/, '').trim()}` : `=${defaultFormula}`;
    grid!.beginDrag(columnKey!, rowKey!, formulaText);
  };

  const showPreview = !!previewCoords && !grid?.dragging && !!previewTokens && previewTokens.length > 0;

  return (
    <td
      className={`${tdClass} relative cursor-pointer group ${error ? 'ring-1 ring-red-400' : ''} ${
        inDragRange ? 'outline outline-2 outline-blue-400 outline-offset-[-1px] bg-blue-50/60' : ''
      }`}
      title={tip}
      onClick={startEdit}
      onMouseEnter={e => {
        if (canFill) grid!.hoverDrag(columnKey!, rowKey!);
        const rect = e.currentTarget.getBoundingClientRect();
        setPreviewCoords({ top: rect.bottom + 2, left: rect.left });
      }}
      onMouseLeave={() => setPreviewCoords(null)}
    >
      <span className="inline-flex items-center gap-0.5">
        {hasOverride && !error && <span className="text-[9px] font-bold text-blue-500" aria-hidden>ƒ</span>}
        {error ? <span className="text-red-500">#ERR</span> : display}
      </span>
      {canFill && (
        <span
          onMouseDown={startFill}
          title="Drag to fill formula down the column"
          className={`absolute bottom-0 right-0 z-10 h-2.5 w-2.5 cursor-crosshair border border-white bg-blue-600 shadow-sm opacity-50 group-hover:opacity-100 ${
            isDragSource ? 'opacity-100' : ''
          }`}
          aria-hidden
        />
      )}
      {showPreview && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[100] flex max-w-[320px] flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-white p-1.5 shadow-lg pointer-events-none"
          style={{ top: previewCoords!.top, left: previewCoords!.left }}
        >
          <span className="font-mono text-xs font-bold text-gray-400">=</span>
          {previewTokens!.map((t, i) =>
            OPS.has(t) ? (
              <span key={i} className="px-0.5 font-mono text-xs text-gray-500">{t}</span>
            ) : (
              <span
                key={i}
                className={`rounded px-1 py-0.5 text-[11px] font-medium ${
                  isNumber(t) ? 'bg-amber-100 text-amber-800' : `${colorForName(t).bg} ${colorForName(t).text}`
                }`}
              >
                {t}
              </span>
            ),
          )}
          {!hasOverride && <span className="ml-1 text-[9px] text-gray-400">(default)</span>}
        </div>,
        document.body,
      )}
    </td>
  );
}
