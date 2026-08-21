import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  createAdminSessionValue,
  parseAdminSession,
  passwordMatches,
} from "@/lib/admin-auth";
import { cookies } from "next/headers";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

export async function GET() {
  const store = await cookies();
  if (!parseAdminSession(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const store = await cookies();
  store.set(ADMIN_COOKIE, "", { ...adminCookieOptions(), maxAge: 0 });
  return NextResponse.json({ success: true });
}

export async function POST(request: NextRequest) {
  try {
    const ipLimit = rateLimit(`admin-auth:${getClientIp(request)}`, {
      limit: 5,
      windowMs: 15 * 60_000,
    });
    if (!ipLimit.ok) {
      return NextResponse.json(
        { success: false, error: "Too many attempts" },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } }
      );
    }

    const { password } = await request.json();
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return NextResponse.json(
        { success: false, error: "Admin authentication not configured" },
        { status: 500 }
      );
    }

    if (!passwordMatches(password)) {
      return NextResponse.json(
        { success: false, error: "Invalid password" },
        { status: 401 }
      );
    }

    const store = await cookies();
    store.set(ADMIN_COOKIE, createAdminSessionValue(), adminCookieOptions());
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, error: "Authentication failed" },
      { status: 500 }
    );
  }
}
