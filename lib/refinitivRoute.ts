import { NextRequest, NextResponse } from "next/server";
import {
  refinitivAuthConfigured,
  refinitivStaticTokenExpired,
  resolveRefinitivAccessToken,
} from "./refinitivAuth";
import { RefinitivHttpError } from "./refinitivHttp";

export function authStatusJson(): NextResponse {
  return NextResponse.json({
    authConfigured: refinitivAuthConfigured(),
    tokenExpired: refinitivStaticTokenExpired(),
  });
}

export async function readJsonBody(
  req: NextRequest
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Request body must be JSON" }, { status: 400 }),
    };
  }
}

export function refinitivErrorResponse(err: unknown): NextResponse {
  if (err instanceof RefinitivHttpError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return NextResponse.json({ error: err.message }, { status });
  }
  const message = err instanceof Error ? err.message : "Refinitiv request failed";
  const lower = message.toLowerCase();
  const status =
    message.includes("must be") ||
    message.includes("Request body") ||
    message.includes("universe") ||
    message.includes("curveDefinition") ||
    message.includes("forwardCurve") ||
    message.includes("fxCrossCode") ||
    message.includes("underlying")
      ? 400
      : lower.includes("not configured") ||
          lower.includes("auth failed") ||
          lower.includes("missing access_token")
        ? 401
        : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function resolveRequestToken(req: NextRequest): Promise<string> {
  return resolveRefinitivAccessToken(req.headers.get("authorization"));
}
