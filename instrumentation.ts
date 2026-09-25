export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Do not import the matcher here. The instrumentation compiler cannot
  // resolve Node `fs` inside pg/sequelize, and webpackIgnore looks next to
  // `.next/server/instrumentation.js` (module not found).
  // The desk starts the process via POST /api/matching-process/start
  // and GET /api/matching-process/heartbeat (ensureMatchingProcess).
}
