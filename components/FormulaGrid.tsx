'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface DragState {
  columnKey: string;
  sourceRowKey: string;
  formula: string;
  hoverRowKey: string;
}

interface FormulaGridApi {
  /** Row keys (e.g. currency codes) in on-screen table order — defines fill direction/range. */
  rowOrder: string[];
  dragging: DragState | null;
  beginDrag: (columnKey: string, rowKey: string, formula: string) => void;
  hoverDrag: (columnKey: string, rowKey: string) => void;
  isInDragRange: (columnKey: string, rowKey: string) => boolean;
}

const FormulaGridContext = createContext<FormulaGridApi | null>(null);

export function useFormulaGrid(): FormulaGridApi | null {
  return useContext(FormulaGridContext);
}

/**
 * Excel-like "fill handle" coordinator for a table column of FormulaCells.
 * Drag from one cell's fill handle down (or up) through other rows in the
 * same column; on release every covered row is committed with the source
 * cell's exact formula text (named refs re-resolve per-row, so this behaves
 * like a relative-reference copy — same as dragging a formula in Excel).
 */
export function FormulaGridProvider({
  rowOrder, onFill, children,
}: {
  rowOrder: string[];
  onFill: (columnKey: string, rowKey: string, formula: string) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const beginDrag = useCallback((columnKey: string, rowKey: string, formula: string) => {
    const state = { columnKey, sourceRowKey: rowKey, formula, hoverRowKey: rowKey };
    dragRef.current = state;
    setDragging(state);
  }, []);

  const hoverDrag = useCallback((columnKey: string, rowKey: string) => {
    if (!dragRef.current || dragRef.current.columnKey !== columnKey) return;
    const next = { ...dragRef.current, hoverRowKey: rowKey };
    dragRef.current = next;
    setDragging(next);
  }, []);

  useEffect(() => {
    const commit = () => {
      const state = dragRef.current;
      if (state) {
        const startIdx = rowOrder.indexOf(state.sourceRowKey);
        const endIdx = rowOrder.indexOf(state.hoverRowKey);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) {
            const rowKey = rowOrder[i];
            if (rowKey !== state.sourceRowKey) onFill(state.columnKey, rowKey, state.formula);
          }
        }
      }
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener('mouseup', commit);
    return () => window.removeEventListener('mouseup', commit);
  }, [rowOrder, onFill]);

  const isInDragRange = useCallback((columnKey: string, rowKey: string) => {
    if (!dragging || dragging.columnKey !== columnKey) return false;
    const startIdx = rowOrder.indexOf(dragging.sourceRowKey);
    const endIdx = rowOrder.indexOf(dragging.hoverRowKey);
    const idx = rowOrder.indexOf(rowKey);
    if (startIdx === -1 || endIdx === -1 || idx === -1) return false;
    const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
    return idx >= lo && idx <= hi;
  }, [dragging, rowOrder]);

  const api = useMemo<FormulaGridApi>(
    () => ({ rowOrder, dragging, beginDrag, hoverDrag, isInDragRange }),
    [rowOrder, dragging, beginDrag, hoverDrag, isInDragRange],
  );

  return <FormulaGridContext.Provider value={api}>{children}</FormulaGridContext.Provider>;
}
