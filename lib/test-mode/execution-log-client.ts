import {
  EXEC_LOG_TAG,
  type ExecutionLogEvent,
} from '@/lib/test-mode/execution-monitor';

export function publishExecutionLogs(events: readonly ExecutionLogEvent[]) {
  if (events.length === 0) return;
  for (const e of events) {
    if (e.kind === 'beat') {
      console.info(`${EXEC_LOG_TAG} ${e.summary}`);
    } else {
      console.info(`${EXEC_LOG_TAG} ${e.summary}`);
    }
  }
  if (typeof fetch === 'undefined') return;
  void fetch('/api/execution-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }).catch(() => {
    /* monitor must never block the tape */
  });
}
