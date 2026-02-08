import { Hono } from "hono";
import { appendFileSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getAccessToken, getTokenExpiry } from "./auth";

const UPSTREAM = "https://api.anthropic.com";
const REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
];
const STRIPPED_BETAS: string[] = [];

// Server-side compaction
const COMPACTION_ENABLED = process.env.CLAUDE_PROXY_COMPACTION !== "false";
const COMPACTION_TRIGGER = parseInt(process.env.CLAUDE_PROXY_COMPACTION_TRIGGER || "800000", 10);
const COMPACTION_BETA = "compact-2026-01-12";

// Prompt caching
const CACHE_ENABLED = process.env.CLAUDE_PROXY_CACHE !== "false";

// Context editing — auto-clear old tool results
const CLEAR_TOOLS_ENABLED = process.env.CLAUDE_PROXY_CLEAR_TOOLS !== "false";
const CONTEXT_MGMT_BETA = "context-management-2025-06-27";

// Server-side web fetch
const WEB_FETCH_ENABLED = process.env.CLAUDE_PROXY_WEB_FETCH !== "false";
const WEB_FETCH_BETA = "web-fetch-2025-09-10";

// max_tokens override
const MAX_TOKENS_OVERRIDE = process.env.CLAUDE_PROXY_MAX_TOKENS
  ? parseInt(process.env.CLAUDE_PROXY_MAX_TOKENS, 10) : null;

// Thinking log
const THINKING_LOG_ENABLED = process.env.CLAUDE_PROXY_THINKING_LOG !== "false";
const THINKING_LOG_PATH = process.env.CLAUDE_PROXY_THINKING_LOG_FILE
  || "/tmp/claude-proxy-thinking.log";

const USER_AGENT = "claude-cli/2.1.2 (external, cli)";
const CC_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

// --- Custom system prompt injection ---
const SYSTEM_PROMPT_PATH = process.env.CLAUDE_PROXY_SYSTEM_FILE
  || join(homedir(), ".config/claude-proxy/system.txt");
let customSystemPrompt: string | null = null;
let customSystemMtime: number = 0;

function getCustomSystem(): string | null {
  try {
    const mtime = statSync(SYSTEM_PROMPT_PATH).mtimeMs;
    if (mtime !== customSystemMtime) {
      customSystemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trim();
      customSystemMtime = mtime;
      if (customSystemPrompt) {
        console.log(`[proxy] Loaded custom system prompt (${customSystemPrompt.length} chars)`);
      }
    }
  } catch {
    customSystemPrompt = null;
  }
  return customSystemPrompt || null;
}

// --- Activity logging ---

function log(msg: string) {
  if (THINKING_LOG_ENABLED) appendFileSync(THINKING_LOG_PATH, msg);
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

// --- Request stats ---

interface RequestRecord {
  ts: string;
  model: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  durationMs: number;
  stopReason: string;
}

const stats = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreation: 0,
  totalCacheRead: 0,
  recentRequests: [] as RequestRecord[],
  activeRequests: 0,
};

const MAX_RECENT = 20;

function recordRequest(rec: RequestRecord) {
  stats.totalRequests++;
  stats.totalInputTokens += rec.inputTokens;
  stats.totalOutputTokens += rec.outputTokens;
  stats.totalCacheCreation += rec.cacheCreation;
  stats.totalCacheRead += rec.cacheRead;
  stats.recentRequests.unshift(rec);
  if (stats.recentRequests.length > MAX_RECENT) stats.recentRequests.pop();
}

// --- Stream interceptor ---

function interceptStream(body: ReadableStream<Uint8Array>, model: string, msgCount: number): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let blockType = "";
  let toolName = "";
  let toolInput = "";
  const reqStart = Date.now();
  let reqInputTokens = 0;
  let reqOutputTokens = 0;
  let reqCacheCreation = 0;
  let reqCacheRead = 0;
  let reqStopReason = "?";
  stats.activeRequests++;

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            stats.activeRequests--;
            recordRequest({
              ts: new Date().toISOString(),
              model,
              messages: msgCount,
              inputTokens: reqInputTokens,
              outputTokens: reqOutputTokens,
              cacheCreation: reqCacheCreation,
              cacheRead: reqCacheRead,
              durationMs: Date.now() - reqStart,
              stopReason: reqStopReason,
            });
            controller.close();
            break;
          }
          controller.enqueue(value);

          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";

          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const data = JSON.parse(dataLine.slice(6));
              const t = data.type;

              if (t === "message_start") {
                const m = data.message;
                const inp = m?.usage?.input_tokens ?? 0;
                reqInputTokens = typeof inp === "number" ? inp : 0;
                reqCacheCreation = m?.usage?.cache_creation_input_tokens ?? 0;
                reqCacheRead = m?.usage?.cache_read_input_tokens ?? 0;
                const cacheInfo = reqCacheRead > 0 ? ` | cache_read=${reqCacheRead}` : (reqCacheCreation > 0 ? ` | cache_write=${reqCacheCreation}` : "");
                log(`\n${"=".repeat(60)}\n[${ts()}] ${m?.model ?? model} | msgs=${msgCount} | in=${inp}${cacheInfo}\n${"=".repeat(60)}\n`);
              } else if (t === "content_block_start") {
                const cb = data.content_block;
                blockType = cb?.type ?? "";
                if (blockType === "thinking") log(`\n[${ts()}] thinking\n`);
                else if (blockType === "text") log(`\n[${ts()}] text\n`);
                else if (blockType === "tool_use") {
                  toolName = cb.name ?? "?";
                  toolInput = "";
                  log(`\n[${ts()}] tool: ${toolName}\n`);
                } else if (blockType === "server_tool_use") {
                  toolName = cb.name ?? "?";
                  toolInput = "";
                  log(`\n[${ts()}] server_tool: ${toolName}\n`);
                }
              } else if (t === "content_block_delta") {
                const d = data.delta;
                if (d?.type === "thinking_delta") log(d.thinking);
                else if (d?.type === "text_delta") log(d.text);
                else if (d?.type === "input_json_delta") toolInput += d.partial_json ?? "";
              } else if (t === "content_block_stop") {
                if ((blockType === "tool_use" || blockType === "server_tool_use") && toolInput) {
                  try {
                    const parsed = JSON.parse(toolInput);
                    log(`  ${JSON.stringify(parsed).slice(0, 150)}\n`);
                  } catch {
                    log(`  ${toolInput.slice(0, 150)}\n`);
                  }
                }
                log("\n");
                blockType = "";
                toolName = "";
                toolInput = "";
              } else if (t === "message_delta") {
                const u = data.usage;
                if (u) {
                  reqOutputTokens = u.output_tokens ?? 0;
                  reqStopReason = data.delta?.stop_reason ?? "?";
                  log(`[${ts()}] done | out=${u.output_tokens} | stop=${reqStopReason}\n`);
                }
              }
            } catch {}
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

const app = new Hono();
const startTime = Date.now();

// --- Build upstream headers ---

function buildHeaders(incoming: Headers, token: string): Headers {
  const headers = new Headers();
  incoming.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower !== "x-api-key" && lower !== "host") {
      headers.set(k, v);
    }
  });
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", USER_AGENT);

  const existing = headers.get("anthropic-beta");
  const betas = new Set(existing ? existing.split(",").map((s) => s.trim()) : []);
  for (const b of REQUIRED_BETAS) betas.add(b);
  for (const b of STRIPPED_BETAS) betas.delete(b);
  headers.set("anthropic-beta", [...betas].join(","));

  return headers;
}

// --- Build upstream URL ---

function buildURL(path: string, incomingUrl: string): string {
  const upstream = new URL(path, UPSTREAM);
  const params = new URL(incomingUrl).searchParams;
  params.forEach((v, k) => upstream.searchParams.set(k, v));
  upstream.searchParams.set("beta", "true");
  return upstream.toString();
}

// --- Ensure system prompt ---

function ensureSystem(body: any): void {
  const custom = getCustomSystem();

  if (!body.system) {
    body.system = [];
  } else if (typeof body.system === "string") {
    body.system = [{ type: "text", text: body.system }];
  }

  const hasAuth = body.system.some(
    (b: any) => b.type === "text" && b.text?.includes(CC_SYSTEM)
  );
  if (!hasAuth) {
    body.system.unshift({ type: "text", text: CC_SYSTEM });
  }

  if (custom) {
    const hasCustom = body.system.some(
      (b: any) => b.type === "text" && b._proxy === true
    );
    if (!hasCustom) {
      body.system.splice(1, 0, {
        type: "text",
        text: custom,
        _proxy: true,
      });
    }
  }
}

// --- Messages relay ---

async function messagesRelay(c: any): Promise<Response> {
  const token = await getAccessToken();
  const headers = buildHeaders(c.req.raw.headers, token);
  const url = buildURL(c.req.path, c.req.url);

  const body = await c.req.json();
  ensureSystem(body);
  if (body.model?.includes("[1m]")) body.model = body.model.replace("[1m]", "");

  // Strip internal markers
  if (Array.isArray(body.system)) {
    for (const block of body.system) delete block._proxy;
  }

  // Prompt caching — respect 4-block API limit
  if (CACHE_ENABLED) {
    const MAX_CACHE_BLOCKS = 4;
    const countCache = (obj: any): number => {
      if (!obj || typeof obj !== "object") return 0;
      let count = 0;
      if (obj.cache_control) count++;
      if (Array.isArray(obj)) {
        for (const item of obj) count += countCache(item);
      } else {
        for (const val of Object.values(obj)) {
          if (val && typeof val === "object") count += countCache(val);
        }
      }
      return count;
    };
    let existing = countCache(body.system) + countCache(body.messages) + countCache(body.tools);

    if (existing < MAX_CACHE_BLOCKS && Array.isArray(body.system) && body.system.length > 0) {
      if (!body.system[body.system.length - 1].cache_control) {
        body.system[body.system.length - 1].cache_control = { type: "ephemeral" };
        existing++;
      }
    }
    if (existing < MAX_CACHE_BLOCKS && Array.isArray(body.tools) && body.tools.length > 0) {
      if (!body.tools[body.tools.length - 1].cache_control) {
        body.tools[body.tools.length - 1].cache_control = { type: "ephemeral" };
      }
    }
  }

  // max_tokens override
  if (MAX_TOKENS_OVERRIDE) body.max_tokens = MAX_TOKENS_OVERRIDE;

  // Context management — merge into existing (Claude Code sends clear_thinking)
  const isOpus = (body.model ?? "").includes("opus");
  if (isOpus) {
    if (!body.context_management) body.context_management = { edits: [] };
    if (!Array.isArray(body.context_management.edits)) body.context_management.edits = [];
    const edits = body.context_management.edits;
    if (COMPACTION_ENABLED && !edits.some((e: any) => e.type === "compact_20260112")) {
      edits.push({
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: COMPACTION_TRIGGER },
      });
    }
    if (CLEAR_TOOLS_ENABLED && !edits.some((e: any) => e.type === "clear_tool_uses_20250919")) {
      edits.push({ type: "clear_tool_uses_20250919" });
    }
  }

  // Server-side web fetch
  if (WEB_FETCH_ENABLED) {
    if (!Array.isArray(body.tools)) body.tools = [];
    if (!body.tools.some((t: any) => t.type === "web_fetch_20250910")) {
      body.tools.push({
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: 5,
      });
    }
  }

  // Beta headers
  const betaHeader = headers.get("anthropic-beta") || "";
  const betasToAdd: string[] = [];
  if (isOpus && COMPACTION_ENABLED && !betaHeader.includes(COMPACTION_BETA)) betasToAdd.push(COMPACTION_BETA);
  if (isOpus && CLEAR_TOOLS_ENABLED && !betaHeader.includes(CONTEXT_MGMT_BETA)) betasToAdd.push(CONTEXT_MGMT_BETA);
  if (WEB_FETCH_ENABLED && !betaHeader.includes(WEB_FETCH_BETA)) betasToAdd.push(WEB_FETCH_BETA);
  if (betasToAdd.length > 0) {
    headers.set("anthropic-beta", betaHeader ? `${betaHeader},${betasToAdd.join(",")}` : betasToAdd.join(","));
  }

  const isStreaming = body.stream === true;
  console.log(`[proxy] → ${url} | model=${body.model} | msgs=${body.messages?.length} | tools=${body.tools?.length ?? 0} | stream=${isStreaming}${body.context_management ? " | ctx_mgmt=" + body.context_management.edits.map((e: any) => e.type).join(",") : ""}`);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.clone().text();
    console.error(`[proxy] API ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const resHeaders = new Headers(res.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");

  const responseBody = (THINKING_LOG_ENABLED && isStreaming && res.body)
    ? interceptStream(res.body, body.model ?? "?", body.messages?.length ?? 0)
    : res.body;

  return new Response(responseBody, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
}

// --- Opaque relay ---

async function opaqueRelay(c: any): Promise<Response> {
  const token = await getAccessToken();
  const headers = buildHeaders(c.req.raw.headers, token);
  const url = buildURL(c.req.path, c.req.url);

  const res = await fetch(url, {
    method: c.req.method,
    headers,
    body: c.req.raw.body,
    // @ts-expect-error Bun supports duplex
    duplex: "half",
  });

  const resHeaders = new Headers(res.headers);
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: resHeaders,
  });
}

// --- Routes ---

app.post("/v1/messages", messagesRelay);
app.post("/messages", messagesRelay);
app.all("/v1/*", opaqueRelay);
app.all("/messages", opaqueRelay);

app.get("/", (c) =>
  c.json({
    name: "claude-max-proxy",
    version: "4.1.0-replit",
    status: "ok",
    mode: "transparent",
  })
);

app.get("/health", (c) => {
  const expiresAt = getTokenExpiry();
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    token: {
      source: process.env.CLAUDE_OAUTH_TOKEN ? "env" : "file",
      expiresIn: expiresAt ? Math.floor((expiresAt - Date.now()) / 1000) : null,
    },
    stats: {
      totalRequests: stats.totalRequests,
      activeRequests: stats.activeRequests,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalCacheCreation: stats.totalCacheCreation,
      totalCacheRead: stats.totalCacheRead,
      recentRequests: stats.recentRequests,
    },
    features: {
      promptCaching: CACHE_ENABLED,
      compaction: { enabled: COMPACTION_ENABLED, trigger: COMPACTION_TRIGGER },
      clearToolResults: CLEAR_TOOLS_ENABLED,
      webFetch: WEB_FETCH_ENABLED,
    },
  });
});

// --- Server ---

export function startServer(opts: { port: number; host: string }) {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    idleTimeout: 255,
    fetch: app.fetch,
  });

  console.log(`[proxy] claude-max-proxy v4.1 (replit)`);
  console.log(`[proxy] Listening on http://${opts.host}:${opts.port}`);
  console.log(`[proxy] Upstream: ${UPSTREAM}`);
  if (THINKING_LOG_ENABLED) {
    try {
      writeFileSync(THINKING_LOG_PATH, `=== claude-max-proxy thinking log ===\n`);
      console.log(`[proxy] Thinking log: ${THINKING_LOG_PATH}`);
    } catch {}
  }
  if (MAX_TOKENS_OVERRIDE) console.log(`[proxy] max_tokens override: ${MAX_TOKENS_OVERRIDE}`);

  const shutdown = () => {
    console.log("\n[proxy] Shutting down...");
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
