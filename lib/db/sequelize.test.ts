import { describe, expect, it, vi } from 'vitest';

// Node 22.2 cannot load undici 8 (`markAsUncloneable`). The helper under
// test does not need Neon/undici — mock the driver graph so the module
// can import.
vi.mock('undici', () => ({
  Agent: class Agent {},
  fetch: async () => new Response(),
}));
vi.mock('@neondatabase/serverless', () => ({
  Client: class Client {},
  Pool: class Pool {},
  defaults: {},
  neonConfig: {},
  types: {},
}));
vi.mock('ws', () => ({ default: class WebSocket {} }));

import { isDatabaseUnreachable } from '@/lib/db/sequelize';

describe('isDatabaseUnreachable', () => {
  it('treats Sequelize connection errors as unreachable', () => {
    expect(isDatabaseUnreachable({ name: 'SequelizeConnectionError' })).toBe(true);
    expect(isDatabaseUnreachable({ parent: { code: 'EACCES' } })).toBe(true);
    expect(isDatabaseUnreachable({ original: { code: 'ECONNREFUSED' } })).toBe(true);
  });

  it('treats dropped sockets as unreachable', () => {
    expect(isDatabaseUnreachable(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDatabaseUnreachable({ code: 'ECONNRESET' })).toBe(true);
  });

  it('does not treat SQL / validation errors as unreachable', () => {
    expect(isDatabaseUnreachable({ name: 'SequelizeUniqueConstraintError' })).toBe(false);
    expect(isDatabaseUnreachable(new Error('Failed to save sandbox progress'))).toBe(false);
  });
});
