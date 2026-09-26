import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ZodType } from 'zod';
import {
  getValidTreasuryAccessToken,
  TreasuryReauthRequiredError,
  TreasuryTemporarilyUnavailableError,
} from '@/lib/treasury/token-store';

/**
 * Thin wrapper over the Treasury Finance MCP server (POST /mcp, JSON-RPC over
 * Streamable HTTP). One client = one connection, reused across the several
 * tool calls a snapshot fetch needs, then closed. See lib/treasury/snapshot.ts
 * for the caller.
 */
export interface TreasuryMcpClient {
  callTool<T>(name: string, args: Record<string, unknown>, schema: ZodType<T>): Promise<T>;
  close(): Promise<void>;
}

const CONNECTION_TIMEOUT_MS = 15_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function isTreasuryMcpConfigured(): boolean {
  return Boolean(process.env.TREASURY_MCP_URL?.trim());
}

export async function connectTreasuryMcpClient(accessToken: string): Promise<TreasuryMcpClient> {
  const url = new URL(requireEnv('TREASURY_MCP_URL'));
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });

  const client = new Client({ name: 'nexus-treasury-client', version: '1.0.0' });
  // `requestInit.signal` above would NOT bound a hang — StreamableHTTPClientTransport
  // overwrites `signal` on every fetch with its own AbortController, which is only
  // aborted by close(). The SDK's own supported deadline is RequestOptions.timeout,
  // passed per-call below: it raises an McpError instead of hanging past
  // DEFAULT_REQUEST_TIMEOUT_MSEC (60s), which would otherwise pin this caller (and,
  // via getValidTreasuryAccessToken's fast path, nothing now — but formerly a
  // Postgres row lock) on a stalled Treasury connection.
  await client.connect(transport, { timeout: CONNECTION_TIMEOUT_MS });

  return {
    async callTool<T>(name: string, args: Record<string, unknown>, schema: ZodType<T>): Promise<T> {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: CONNECTION_TIMEOUT_MS,
      });
      return parseToolResult(result, name, schema);
    },
    async close() {
      // Deliberately NOT calling transport.terminateSession() here: it's a
      // raw DELETE fetch, not a JSON-RPC request, so RequestOptions.timeout
      // above does not cover it — the SDK overwrites the abort signal on
      // that fetch the same way it did for the request we just fixed, and
      // it can only be aborted by close() itself. A stalled DELETE would
      // hang this call (and the /workspace render awaiting it) for as long
      // as the underlying transport's default timeout, undoing the point of
      // the fix above. The server-side MCP session simply lapses on
      // Treasury's own idle timeout instead — no different from a client
      // that disconnects without a graceful goodbye.
      await client.close();
    },
  };
}

export function extractText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = content.find(
    (block): block is { type: 'text'; text: string } =>
      Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'text',
  );
  return first?.text ?? null;
}

/**
 * Extracted as a pure function so the isError/JSON.parse/schema validation
 * path — the part that decides whether a malformed Treasury payload becomes
 * a wrong number or an honest error — is directly unit-testable without
 * standing up (or mocking) the MCP SDK's Client class.
 *
 * Takes `unknown` rather than a named shape: the SDK's own callTool() return
 * type is a wide union (legacy vs current result schema variants) that
 * doesn't structurally match any single simple object type we'd declare
 * here — narrowing at runtime is both simpler and more robust to it evolving.
 */
export function parseToolResult<T>(result: unknown, toolName: string, schema: ZodType<T>): T {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};

  if (record.isError) {
    const message = extractText(record.content) ?? `Tool ${toolName} returned an error`;
    throw new Error(`Treasury MCP tool "${toolName}" failed: ${message}`);
  }

  const text = extractText(record.content);
  if (!text) {
    throw new Error(`Treasury MCP tool "${toolName}" returned no text content`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Treasury MCP tool "${toolName}" returned non-JSON content`);
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Treasury MCP tool "${toolName}" returned an unexpected shape: ${validated.error.message}`);
  }
  return validated.data;
}

export type TreasuryClientStatus = 'not_connected' | 'live' | 'reauth_required' | 'error';

export type WithTreasuryClientOutcome<T> =
  | { status: 'live'; data: T }
  | { status: 'not_connected' }
  | { status: 'reauth_required' }
  | { status: 'error'; errorMessage: string };

/**
 * Shared token + connect + close wrapper used by every read-only Treasury
 * tool helper (accounts, notional pool, blotter, FX P&L). Never throws —
 * maps auth/connect/tool failures onto the same status union the UI already
 * knows how to render.
 */
export async function withTreasuryClient<T>(
  email: string,
  logPrefix: string,
  fn: (client: TreasuryMcpClient) => Promise<T>,
): Promise<WithTreasuryClientOutcome<T>> {
  if (!isTreasuryMcpConfigured()) return { status: 'not_connected' };

  let accessToken: string | null;
  try {
    accessToken = await getValidTreasuryAccessToken(email);
  } catch (err) {
    if (err instanceof TreasuryReauthRequiredError) return { status: 'reauth_required' };
    if (err instanceof TreasuryTemporarilyUnavailableError) {
      console.warn(`${logPrefix} token refresh temporarily unavailable`, err);
      return { status: 'error', errorMessage: err.message };
    }
    console.error(`${logPrefix} token lookup failed`, err);
    return { status: 'error', errorMessage: 'Could not verify your Treasury connection.' };
  }
  if (!accessToken) return { status: 'not_connected' };

  let client: TreasuryMcpClient;
  try {
    client = await connectTreasuryMcpClient(accessToken);
  } catch (err) {
    console.error(`${logPrefix} MCP connect failed`, err);
    return {
      status: 'error',
      errorMessage: 'Treasury data is temporarily unavailable — try again shortly.',
    };
  }

  try {
    const data = await fn(client);
    return { status: 'live', data };
  } catch (err) {
    console.error(`${logPrefix} tool call failed`, err);
    return {
      status: 'error',
      errorMessage: err instanceof Error
        ? err.message
        : 'Treasury data is temporarily unavailable — try again shortly.',
    };
  } finally {
    await client.close().catch(err => {
      console.warn(`${logPrefix} error closing MCP client (ignored)`, err);
    });
  }
}
