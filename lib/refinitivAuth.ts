const TOKEN_URL = "https://api.refinitiv.com/auth/oauth2/v1/token";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;
let cachedRefresh: string | null = null;

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function jwtExpUnix(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(pad, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Opaque tokens are treated as usable; JWTs must be unexpired (30s skew). */
export function isUsableAccessToken(token: string, skewSec = 30): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const exp = jwtExpUnix(trimmed);
  if (exp === null) return true;
  return Date.now() / 1000 < exp - skewSec;
}

function hasPasswordGrant(): boolean {
  return Boolean(env("REFINITIV_CLIENT_ID") && env("REFINITIV_USERNAME") && env("REFINITIV_PASSWORD"));
}

function hasRefreshGrant(): boolean {
  return Boolean(env("REFINITIV_CLIENT_ID") && (cachedRefresh || env("REFINITIV_REFRESH_TOKEN")));
}

export function refinitivAuthConfigured(): boolean {
  const staticToken = env("REFINITIV_ACCESS_TOKEN");
  if (staticToken && isUsableAccessToken(staticToken)) return true;
  return hasRefreshGrant() || hasPasswordGrant();
}

export function refinitivStaticTokenExpired(): boolean {
  const staticToken = env("REFINITIV_ACCESS_TOKEN");
  return Boolean(staticToken && !isUsableAccessToken(staticToken));
}

function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = header.trim().match(/^Bearer\s+(.+)$/i);
  const token = (match ? match[1] : header).trim();
  return token || undefined;
}

function tokenFromGrantPayload(payload: unknown, status: number): CachedToken {
  if (!payload || typeof payload !== "object") {
    throw new Error(`Refinitiv auth failed (${status})`);
  }
  const rec = payload as Record<string, unknown>;
  if (typeof rec.access_token !== "string" || !rec.access_token) {
    throw new Error("Refinitiv auth response missing access_token");
  }
  if (typeof rec.refresh_token === "string" && rec.refresh_token.trim()) {
    cachedRefresh = rec.refresh_token.trim();
  }
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : 300;
  return {
    token: rec.access_token,
    expiresAtMs: Date.now() + Math.max(30, expiresIn - 30) * 1000,
  };
}

async function postToken(body: URLSearchParams): Promise<CachedToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Refinitiv auth failed (${res.status})`);
  }
  if (!res.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error_description" in payload &&
      typeof payload.error_description === "string"
        ? payload.error_description
        : `Refinitiv auth failed (${res.status})`;
    throw new Error(message);
  }
  return tokenFromGrantPayload(payload, res.status);
}

async function fetchRefreshGrantToken(): Promise<CachedToken> {
  const clientId = env("REFINITIV_CLIENT_ID");
  const refresh = cachedRefresh ?? env("REFINITIV_REFRESH_TOKEN");
  if (!clientId || !refresh) {
    throw new Error("Refinitiv refresh_token is not configured.");
  }
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    })
  );
}

async function fetchPasswordGrantToken(): Promise<CachedToken> {
  const clientId = env("REFINITIV_CLIENT_ID");
  const username = env("REFINITIV_USERNAME");
  const password = env("REFINITIV_PASSWORD");
  if (!clientId || !username || !password) {
    throw new Error(
      "Refinitiv credentials are not configured. Set REFINITIV_ACCESS_TOKEN or REFINITIV_CLIENT_ID / REFINITIV_USERNAME / REFINITIV_PASSWORD."
    );
  }

  return postToken(
    new URLSearchParams({
      grant_type: "password",
      username,
      password,
      client_id: clientId,
      scope: "trapi",
      takeExclusiveSignOnControl: "true",
    })
  );
}

async function mintAccessToken(): Promise<string> {
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.token;
  }
  if (hasRefreshGrant()) {
    cached = await fetchRefreshGrantToken();
    return cached.token;
  }
  if (hasPasswordGrant()) {
    cached = await fetchPasswordGrantToken();
    return cached.token;
  }
  throw new Error(
    "Refinitiv access token has expired. Paste a fresh Bearer, or set REFINITIV_CLIENT_ID with USERNAME/PASSWORD or REFRESH_TOKEN to auto-renew."
  );
}

export async function resolveRefinitivAccessToken(
  authorizationHeader: string | null
): Promise<string> {
  const headerToken = bearerFromHeader(authorizationHeader);
  if (headerToken && isUsableAccessToken(headerToken)) return headerToken;

  const staticToken = env("REFINITIV_ACCESS_TOKEN");
  if (staticToken && isUsableAccessToken(staticToken)) return staticToken;

  return mintAccessToken();
}
