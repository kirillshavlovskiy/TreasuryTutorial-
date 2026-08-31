'use client';

import { POLICY_VAR_LIMITS, varApprovalRequired } from '@/lib/fx-buffer';
import {
  markPreparedApproval,
  type PreparedHedgeProfile,
} from '@/lib/test-mode/hedge-var';

function fmtVarK(usdM: number): string {
  if (!Number.isFinite(usdM) || Math.abs(usdM) < 1e-12) return '$0K';
  if (Math.abs(usdM) >= 0.1) return `$${usdM.toFixed(2)}M`;
  return `$${(usdM * 1000).toFixed(0)}K`;
}

const LENS_LABEL: Record<string, string> = {
  var: 'FX Risk',
  carry: 'Cash Carry',
  liquidity: 'Liquidity',
};

type PreparedChange = (
  next: Record<string, PreparedHedgeProfile>,
) => void;

export function HedgeApprovalStep({
  preparedByCcy = {},
  onPreparedByCcyChange,
  varUsdM,
  includedCcys,
  preparedFor,
  emptyHint,
}: {
  preparedByCcy?: Record<string, PreparedHedgeProfile>;
  onPreparedByCcyChange?: PreparedChange;
  varUsdM: number;
  /** Portfolio include-set — omitted/null means every staged CCY. */
  includedCcys?: ReadonlySet<string> | null;
  /** Limit this step to one analytics lens (Liquidity → funding strips). */
  preparedFor?: PreparedHedgeProfile['preparedFor'];
  emptyHint?: string;
}) {
  const policy = varApprovalRequired(varUsdM);
  const inScope = (ccy: string, p: PreparedHedgeProfile) => {
    if (includedCcys && !includedCcys.has(ccy)) return false;
    if (preparedFor && p.preparedFor !== preparedFor) return false;
    return true;
  };
  const entries = Object.entries(preparedByCcy).filter(([ccy, p]) => inScope(ccy, p));
  const drafts = entries.filter(([, p]) => p.approvalStatus === 'draft');
  const pending = entries.filter(([, p]) => p.approvalStatus === 'pending');
  const released = entries.filter(
    ([, p]) => p.approvalStatus == null || p.approvalStatus === 'approved',
  );

  const patch = {
    who: policy.who,
    onlyCcys: includedCcys ?? undefined,
    preparedFor,
  };

  const emit = (
    updater: (
      prev: Record<string, PreparedHedgeProfile>,
    ) => Record<string, PreparedHedgeProfile>,
  ) => {
    if (!onPreparedByCcyChange) return;
    onPreparedByCcyChange(updater(preparedByCcy));
  };

  const releaseDrafts = () => {
    emit(prev =>
      markPreparedApproval(prev, {
        ...patch,
        status: policy.needed ? 'pending' : 'approved',
        from: 'draft',
      }),
    );
  };

  const approvePending = () => {
    emit(prev =>
      markPreparedApproval(prev, {
        ...patch,
        status: 'approved',
        from: 'pending',
      }),
    );
  };

  const varLabel = Number.isFinite(varUsdM) ? `$${varUsdM.toFixed(1)}M` : '—';

  return (
    <section className="space-y-3">
      <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-slate-500">
          VAR policy · 95%
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Residual VAR {varLabel}
          {policy.needed
            ? ` — ${policy.who} sign-off before Hedging Decision.`
            : ' — Treasury can release straight to Hedging Decision.'}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {POLICY_VAR_LIMITS.map(pl => {
            const active =
              (pl.usd === 5 && policy.who === 'Treasury')
              || (pl.usd === 10 && policy.who === 'Director of Finance')
              || (pl.usd === 20 && policy.who === 'CFO');
            return (
              <span
                key={pl.usd}
                className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  active
                    ? 'border-violet-400/60 bg-violet-500/20 text-violet-100'
                    : 'border-slate-700 bg-slate-950 text-slate-500'
                }`}
              >
                {pl.label} · {pl.who}
              </span>
            );
          })}
          <span
            className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${
              policy.who === 'CEO'
                ? 'border-amber-400/60 bg-amber-500/20 text-amber-100'
                : 'border-slate-700 bg-slate-950 text-slate-500'
            }`}
          >
            &gt;$20M · CEO
          </span>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-8 text-center text-xs text-slate-500">
          {emptyHint
            ?? 'Stage a hedge package on the previous step, then send it for approval here. Only approved packages appear on Hedging Decision.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950/40">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500">
                <th className="px-3 py-2 font-medium">CCY</th>
                <th className="px-3 py-2 font-medium">Lens</th>
                <th className="px-3 py-2 font-medium">Structure</th>
                <th className="px-3 py-2 font-medium">Cover</th>
                <th className="px-3 py-2 font-medium">Carry</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([ccy, p]) => (
                <tr key={ccy} className="border-b border-slate-800/70 last:border-0">
                  <td className="px-3 py-2 font-mono font-semibold text-slate-200">{ccy}</td>
                  <td className="px-3 py-2 text-slate-400">
                    {p.preparedFor ? LENS_LABEL[p.preparedFor] ?? p.preparedFor : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-300">
                    {p.structure === 'strip' && p.legs.length > 1
                      ? `strip · ${p.legs.length}`
                      : p.structure}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-300">
                    {`${p.coverLocalM >= 0 ? '+' : '−'}${Math.abs(p.coverLocalM).toFixed(2)}M`}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono ${
                      (p.impliedCarryUsdM ?? 0) >= 0
                        ? 'text-emerald-300/90'
                        : 'text-rose-300/90'
                    }`}
                  >
                    {p.impliedCarryUsdM == null ? '—' : fmtVarK(p.impliedCarryUsdM)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={p.approvalStatus} who={p.approvalWho} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {drafts.length > 0 && onPreparedByCcyChange && (
          <button
            type="button"
            onClick={releaseDrafts}
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${
              policy.needed
                ? 'border-amber-500/50 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                : 'border-emerald-500/50 bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30'
            }`}
          >
            {policy.needed
              ? `Send ${drafts.length} for ${policy.who} approval`
              : `Release ${drafts.length} to Hedging Decision`}
          </button>
        )}
        {pending.length > 0 && onPreparedByCcyChange && (
          <button
            type="button"
            onClick={approvePending}
            className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/30"
          >
            Approve as {policy.who} ({pending.length})
          </button>
        )}
        {drafts.length === 0 && pending.length === 0 && released.length > 0 && (
          <p className="text-[11px] text-slate-500">
            Approved packages are on the Hedging Decision tab.
          </p>
        )}
      </div>
    </section>
  );
}

function StatusPill({
  status,
  who,
}: {
  status?: PreparedHedgeProfile['approvalStatus'];
  who?: string;
}) {
  if (status === 'draft') {
    return (
      <span className="rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
        Draft
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-100">
        Pending{who ? ` · ${who}` : ''}
      </span>
    );
  }
  return (
    <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-100">
      On Hedging Decision{who ? ` · ${who}` : ''}
    </span>
  );
}
