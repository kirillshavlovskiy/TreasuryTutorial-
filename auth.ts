import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';

export interface SessionData {
  email: string;
  name?: string;
  picture?: string;
}

export type Session = SessionData & {
  iat: number;
  exp: number;
};

export interface AuthSession {
  user: {
    email: string;
    name?: string;
    image?: string;
  };
  expires: string;
}

const SESSION_COOKIE = 'fx-workbench-session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sessionSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required to sign session cookies');
  }
  return secret;
}

/** Callers can surface a configuration error instead of failing mid-request. */
export function isSessionConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET?.trim());
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function serializeSession(data: SessionData): { value: string; session: Session } {
  const iat = Math.floor(Date.now() / 1000);
  const session: Session = {
    email: data.email,
    ...(data.name ? { name: data.name } : {}),
    ...(data.picture ? { picture: data.picture } : {}),
    iat,
    exp: iat + SESSION_TTL_SECONDS,
  };
  const payload = encode(JSON.stringify(session));
  return { value: `${payload}.${sign(payload)}`, session };
}

function parseSession(value: string): Session | null {
  try {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra) return null;

    const expected = Buffer.from(sign(payload), 'base64url');
    const actual = Buffer.from(signature, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }

    const parsed = JSON.parse(decode(payload)) as Partial<Session>;
    if (
      typeof parsed.email !== 'string'
      || !parsed.email.trim()
      || typeof parsed.iat !== 'number'
      || typeof parsed.exp !== 'number'
      || parsed.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return parsed as Session;
  } catch {
    return null;
  }
}

export async function setSessionCookie(
  response: NextResponse,
  sessionData: SessionData,
): Promise<void> {
  const { value, session } = serializeSession(sessionData);
  response.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.exp * 1000),
  });
}

export async function clearSessionCookie(response: NextResponse): Promise<void> {
  response.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
}

export async function auth(): Promise<AuthSession | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(SESSION_COOKIE)?.value;
  if (!value) return null;

  const session = parseSession(value);
  if (!session) return null;

  return {
    user: {
      email: session.email,
      ...(session.name ? { name: session.name } : {}),
      ...(session.picture ? { image: session.picture } : {}),
    },
    expires: new Date(session.exp * 1000).toISOString(),
  };
}
