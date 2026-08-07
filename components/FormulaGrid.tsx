'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface DragOrigin {
  /** Source cell centre — used to lock the fill axis while the pointer drifts. */
  x: number;
  y: number;
}

interface DragState {
  columnKey: string;
  sourceRowKey: string;
  formula: string;
  hoverRowKey: string;
  origin: DragOrigin;
}

interface FormulaGridApi {
  /** Row keys in on-screen order — defines fill direction/range. */
  rowOrder: string[];
  dragging: DragState | null;
  beginDrag: (
    columnKey: string,
    rowKey: string,
    formula: string,
    origin?: DragOrigin,
  ) => void;
  hoverDrag: (columnKey: string, rowKey: string) => void;
  isInDragRange: (columnKey: string, rowKey: string) => boolean;
  /** Only one FormulaCell editor at a time (key = columnKey::rowKey). */
  activeEditKey: string | null;
  beginEdit: (editKey: string) => void;
  endEdit: (editKey: string) => void;
  /** Insert a named ref into the active editor (Excel-like cell click). */
  insertRefToken: (token: string) => boolean;
  registerRefInserter: (
    editKey: string,
    inserter: (token: string) => void,
  ) => void;
  unregisterRefInserter: (editKey: string) => void;
}

const FormulaGridContext = createContext<FormulaGridApi | null>(null);

export function useFormulaGrid(): FormulaGridApi | null {
  return useContext(FormulaGridContext);
}

export function formulaEditKey(columnKey: string, rowKey: string): string {
  return `${columnKey}::${rowKey}`;
}

/** Split `columnKey::rowKey` — columnKey may itself contain `::`. */
export function parseFormulaEditKey(editKey: string): {
  columnKey: string;
  rowKey: string;
} {
  const idx = editKey.lastIndexOf('::');
  if (idx === -1) return { columnKey: editKey, rowKey: '' };
  return { columnKey: editKey.slice(0, idx), rowKey: editKey.slice(idx + 2) };
}

function formulaCellFromPoint(
  clientX: number,
  clientY: number,
): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const node of stack) {
    if (!(node instanceof Element)) continue;
    const cell = node.closest('[data-formula-col][data-formula-row]');
    if (cell instanceof HTMLElement) return cell;
  }
  return null;
}

function rowKeyFromCell(
  cell: HTMLElement | null,
  columnKey: string,
): string | null {
  if (!cell) return null;
  if (cell.getAttribute('data-formula-col') !== columnKey) return null;
  return cell.getAttribute('data-formula-row');
}

/**
 * Excel-like fill-handle + single-editor coordinator for FormulaCells.
 *
 * Fill: drag from one cell's handle through other rows in the same column;
 * on release every covered row gets the source formula (optionally rewritten
 * by the parent — e.g. relative month refs). Pointer may drift off the row —
 * hit-testing locks to the source row/column axis so the range keeps updating.
 *
 * Edit: only one portaled editor is open; starting another cell closes the
 * previous (parent FormulaCell commits on deactivate).
 */
export function FormulaGridProvider({
  rowOrder,
  onFill,
  children,
}: {
  rowOrder: string[];
  /**
   * Apply `formula` to every `rowKey` in the drag range (excluding the source).
   * `sourceRowKey` is the cell the fill started from (for relative ref shifts).
   */
  onFill: (
    columnKey: string,
    rowKeys: string[],
    formula: string,
    sourceRowKey: string,
  ) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [activeEditKey, setActiveEditKey] = useState<string | null>(null);
  const refInsertersRef = useRef<Map<string, (token: string) => void>>(
    new Map(),
  );

  const beginDrag = useCallback(
    (
      columnKey: string,
      rowKey: string,
      formula: string,
      origin?: DragOrigin,
    ) => {
      const state: DragState = {
        columnKey,
        sourceRowKey: rowKey,
        formula,
        hoverRowKey: rowKey,
        origin: origin ?? { x: 0, y: 0 },
      };
      dragRef.current = state;
      setDragging(state);
      setActiveEditKey(null);
    },
    [],
  );

  const hoverDrag = useCallback((columnKey: string, rowKey: string) => {
    if (!dragRef.current || dragRef.current.columnKey !== columnKey) return;
    if (dragRef.current.hoverRowKey === rowKey) return;
    const next = { ...dragRef.current, hoverRowKey: rowKey };
    dragRef.current = next;
    setDragging(next);
  }, []);

  const beginEdit = useCallback((editKey: string) => {
    setActiveEditKey(editKey);
  }, []);

  const endEdit = useCallback((editKey: string) => {
    setActiveEditKey(prev => (prev === editKey ? null : prev));
    refInsertersRef.current.delete(editKey);
  }, []);

  const registerRefInserter = useCallback(
    (editKey: string, inserter: (token: string) => void) => {
      refInsertersRef.current.set(editKey, inserter);
    },
    [],
  );

  const unregisterRefInserter = useCallback((editKey: string) => {
    refInsertersRef.current.delete(editKey);
  }, []);

  const insertRefToken = useCallback((token: string): boolean => {
    const key = activeEditKey;
    if (!key || !token.trim()) return false;
    const inserter = refInsertersRef.current.get(key);
    if (!inserter) return false;
    inserter(token.trim());
    return true;
  }, [activeEditKey]);

  // Axis-locked pointer tracking — cursor may leave the row/column freely.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (ev: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      const { columnKey, origin } = state;

      // Project onto the source row (horizontal fill) and source column (vertical).
      const alongRow = rowKeyFromCell(
        formulaCellFromPoint(ev.clientX, origin.y),
        columnKey,
      );
      const alongCol = rowKeyFromCell(
        formulaCellFromPoint(origin.x, ev.clientY),
        columnKey,
      );
      const direct = rowKeyFromCell(
        formulaCellFromPoint(ev.clientX, ev.clientY),
        columnKey,
      );

      const nextRow = alongRow ?? alongCol ?? direct;
      if (nextRow == null) return;
      if (state.hoverRowKey === nextRow) return;
      const next = { ...state, hoverRowKey: nextRow };
      dragRef.current = next;
      setDragging(next);
    };

    const onUp = () => {
      const state = dragRef.current;
      if (state) {
        const startIdx = rowOrder.indexOf(state.sourceRowKey);
        const endIdx = rowOrder.indexOf(state.hoverRowKey);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] =
            startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const targets: string[] = [];
          for (let i = lo; i <= hi; i++) {
            const rowKey = rowOrder[i];
            if (rowKey && rowKey !== state.sourceRowKey) targets.push(rowKey);
          }
          if (targets.length > 0) {
            onFill(
              state.columnKey,
              targets,
              state.formula,
              state.sourceRowKey,
            );
          }
        }
      }
      dragRef.current = null;
      setDragging(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, rowOrder, onFill]);

  const isInDragRange = useCallback(
    (columnKey: string, rowKey: string) => {
      if (!dragging || dragging.columnKey !== columnKey) return false;
      const startIdx = rowOrder.indexOf(dragging.sourceRowKey);
      const endIdx = rowOrder.indexOf(dragging.hoverRowKey);
      const idx = rowOrder.indexOf(rowKey);
      if (startIdx === -1 || endIdx === -1 || idx === -1) return false;
      const [lo, hi] =
        startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      return idx >= lo && idx <= hi;
    },
    [dragging, rowOrder],
  );

  const api = useMemo<FormulaGridApi>(
    () => ({
      rowOrder,
      dragging,
      beginDrag,
      hoverDrag,
      isInDragRange,
      activeEditKey,
      beginEdit,
      endEdit,
      insertRefToken,
      registerRefInserter,
      unregisterRefInserter,
    }),
    [
      rowOrder,
      dragging,
      beginDrag,
      hoverDrag,
      isInDragRange,
      activeEditKey,
      beginEdit,
      endEdit,
      insertRefToken,
      registerRefInserter,
      unregisterRefInserter,
    ],
  );

  return (
    <FormulaGridContext.Provider value={api}>
      {children}
    </FormulaGridContext.Provider>
  );
}
