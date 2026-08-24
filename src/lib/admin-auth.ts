import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const ADMIN_COOKIE = "credits_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string | null {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || null;
}

export function passwordMatches(provided: unknown): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof provided !== "string" || provided.length === 0) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createAdminSessionValue(): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("Admin session secret missing");
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, n: randomBytes(16).toString("hex") })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function parseAdminSession(value: string | undefined | null): boolean {
  if (!value) return false;
  const secret = sessionSecret();
  if (!secret) return false;
  const [payload, signature, ...extra] = value.split(".");
  if (!payload || !signature || extra.length > 0) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function adminCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

export async function requireAdminApi(): Promise<NextResponse | null> {
  const store = await cookies();
  if (!parseAdminSession(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
