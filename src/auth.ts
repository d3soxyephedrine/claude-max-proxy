import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// Auth source priority:
// 1. CLAUDE_OAUTH_TOKEN env var (Replit secrets — no file needed)
// 2. CLAUDE_OAUTH_FILE env var (custom path)
// 3. ~/.local/share/opencode/auth.json (default, local dev)
const AUTH_PATH = process.env.CLAUDE_OAUTH_FILE
  || join(homedir(), ".local/share/opencode/auth.json");
const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const EXPIRY_BUFFER_MS = 60_000;

interface AuthData {
  anthropic: {
    type: string;
    access: string;
    refresh: string;
    expires: number;
  };
}

let cached: AuthData | null = null;
let refreshing: Promise<string> | null = null;

// When using env var auth, we have access+refresh but no expiry tracking.
// We assume the token is valid and refresh on 401.
let envTokenExpires = 0;

function initFromEnv(): AuthData | null {
  const access = process.env.CLAUDE_OAUTH_TOKEN;
  const refresh = process.env.CLAUDE_OAUTH_REFRESH;
  if (!access) return null;
  console.log("[auth] Using CLAUDE_OAUTH_TOKEN from environment");
  envTokenExpires = Date.now() + 3600_000; // assume 1h validity
  return {
    anthropic: {
      type: "oauth",
      access,
      refresh: refresh || "",
      expires: envTokenExpires,
    },
  };
}

async function readAuth(): Promise<AuthData> {
  const raw = await readFile(AUTH_PATH, "utf-8");
  return JSON.parse(raw);
}

async function writeAuth(data: AuthData): Promise<void> {
  // Only write to file if not using env var auth
  if (process.env.CLAUDE_OAUTH_TOKEN) return;
  await writeFile(AUTH_PATH, JSON.stringify(data, null, 2) + "\n");
}

async function refreshToken(auth: AuthData): Promise<string> {
  if (!auth.anthropic.refresh) {
    throw new Error("No refresh token available. Set CLAUDE_OAUTH_REFRESH env var.");
  }
  console.log("[auth] Refreshing OAuth token...");
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: auth.anthropic.refresh,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  auth.anthropic.access = data.access_token;
  if (data.refresh_token) auth.anthropic.refresh = data.refresh_token;
  auth.anthropic.expires = Date.now() + data.expires_in * 1000;

  await writeAuth(auth);
  cached = auth;
  console.log("[auth] Token refreshed, expires in", data.expires_in, "s");
  return auth.anthropic.access;
}

export async function getAccessToken(): Promise<string> {
  if (!cached) {
    cached = initFromEnv() || await readAuth();
  }

  if (Date.now() < cached.anthropic.expires - EXPIRY_BUFFER_MS) {
    return cached.anthropic.access;
  }

  // Mutex: single concurrent refresh
  if (!refreshing) {
    refreshing = refreshToken(cached).finally(() => { refreshing = null; });
  }
  return refreshing;
}

export function getTokenExpiry(): number {
  return cached?.anthropic.expires ?? 0;
}
