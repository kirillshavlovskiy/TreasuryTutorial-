'use client';

import { useMemo, useState } from 'react';
import type { ExecutionLogEvent } from '@/lib/test-mode/execution-monitor';
import type { MatchingHeartbeatView } from '@/lib/test-mode/matching-process-client';

type FilterId = 'all' | 'fills' | 'blocked' | 'working' | 'beats';

function clock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mss = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mss}`;
}

function tone(e: ExecutionLogEvent): string {
  if (e.kind === 'beat') return 'text-slate-400';
  if (e.outcome === 'filled') return 'text-emerald-300';
  if (e.outcome === 'cancelled' || e.outcome === 'rejected') return 'text-rose-300';
  if (e.outcome === 'blocked-policy') return 'text-rose-300';
  if (e.outcome === 'working') return 'text-sky-300';
  return 'text-slate-500';
}

function matches(e: ExecutionLogEvent, filter: FilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'beats') return e.kind === 'beat';
  if (e.kind !== 'order') return false;
  if (filter === 'fills') return e.outcome === 'filled';
  if (filter === 'blocked') return e.outcome === 'blocked-policy';
  return e.outcome === 'working';
}

function heartbeatTone(verdict: MatchingHeartbeatView['verdict'] | undefined): string {
  if (verdict === 'live') return 'text-emerald-300';
  if (verdict === 'stale') return 'text-amber-300';
  return 'text-rose-300';
}

function beatHeader(
  heartbeat: MatchingHeartbeatView | null | undefined,
  events: readonly ExecutionLogEvent[],
): string {
  const live = heartbeat?.lastBeat?.summary;
  const logged = events.find(e => e.kind === 'beat');
  return (
    live
    ?? (logged && logged.kind === 'beat' ? logged.summary : null)
    ?? 'Tape matcher · waiting for first tick'
  );
}

export function ExecutionMonitorPanel({
  events,
  heartbeat,
}: {
  events: readonly ExecutionLogEvent[];
  heartbeat?: MatchingHeartbeatView | null;
}) {
  const [filter, setFilter] = useState<FilterId>('all');
  const rows = useMemo(
    () => events.filter(e => matches(e, filter)).slice(0, 80),
    [events, filter],
  );

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/70">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-[12px] font-semibold tracking-tight text-slate-100">
            Order monitor
          </h4>
          <p className="font-mono text-[10px] text-cyan-200/90">
            {beatHeader(heartbeat, events)}
          </p>
        </div>
        {heartbeat && (
          <p
            className={`w-full font-mono text-[10px] ${heartbeatTone(heartbeat.verdict)}`}
          >
            NODE {heartbeat.verdict.toUpperCase()}
            {heartbeat.processAlive ? ' · process alive' : ' · process down'}
            {heartbeat.ageMs != null ? ` · last tick ${heartbeat.ageMs}ms ago` : ''}
            {` · ${heartbeat.tickCount} ticks`}
            {` · ${heartbeat.workingOrders} working`}
            {heartbeat.survivesBrowserClose
              ? ' · survives browser close'
              : ' · browser-bound'}
            {heartbeat.probe
              ? heartbeat.probe.advanced
                ? ' · probe advanced without a tab'
                : ' · probe did not advance'
              : ''}
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          {(
            [
              ['all', 'All'],
              ['fills', 'Fills'],
              ['blocked', 'Blocked'],
              ['working', 'Working'],
              ['beats', 'Beats'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                filter === id
                  ? 'bg-cyan-500/20 text-cyan-200'
                  : 'bg-slate-900 text-slate-500 hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
        <div className="max-h-[28rem] overflow-auto px-3 py-2">
          {rows.length === 0 ? (
            <p className="py-6 text-center font-mono text-[10px] text-slate-600">
              No matcher events yet. Leave a resting order and the tape will
              log each beat, fill basis, and policy check here and in server
              logs as {`[fx-exec]`}.
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((e, i) => (
                <li
                  key={`${e.kind}-${e.atMs}-${i}`}
                  className={`font-mono text-[10px] leading-4 ${tone(e)}`}
                >
                  <span className="text-slate-600">{clock(e.atMs)}</span>
                  {'  '}
                  {e.kind === 'order' ? (
                    <>
                      <span className="text-slate-500">{e.ccy}</span>
                      {' · '}
                      <span className="text-violet-300">{e.basis}</span>
                      {' · '}
                    </>
                  ) : null}
                  {e.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
    </section>
  );
}
