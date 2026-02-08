import { startServer } from "../src/server";

const port = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const host = process.env.CLAUDE_PROXY_HOST || "0.0.0.0";

startServer({ port, host });
