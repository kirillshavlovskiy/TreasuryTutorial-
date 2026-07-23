import Link from 'next/link';

const TASKS = [
  {
    id: '01',
    title: 'SIGMA TASK 01 — Map the Book',
    episode: 'E01 — The Imbalanced Balance Sheet',
    time: '~15 minutes',
    steps: [
      'Create FX dashboard + profile on each legal entity',
      'Find largest mismatch on Group FX',
      'Configure VaR in Analytics (confidence · horizon · exposure)',
      'Identify VaR at Δ = 1 for your setup and Validate (±5%)',
    ],
  },
] as const;

export default function TestHubPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Sigma Tasks</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Hands-on exercises on the Simple Sigma Test Dashboard. Each task uses the NordTech
        sample book and scores your ladder against a hidden reference (±5%).
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {TASKS.map(task => (
          <Link
            key={task.id}
            href={`/test/tasks/${task.id}`}
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-emerald-600/50"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-emerald-400">
              Episode {task.episode}
            </div>
            <h2 className="mt-2 text-lg font-semibold text-white">{task.title}</h2>
            <p className="mt-1 text-xs text-slate-500">{task.time}</p>
            <ol className="mt-4 list-decimal space-y-1 pl-4 text-sm text-slate-400">
              {task.steps.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="mt-5 text-sm font-medium text-emerald-400">Open task →</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
