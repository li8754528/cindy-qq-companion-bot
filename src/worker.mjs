import readline from "node:readline";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { QQBotFleet } from "./qq-fleet.mjs";
const output = value => process.stdout.write(JSON.stringify(value) + "\n");
const bridge = new QQBotFleet(options => new QQBot(options), (method, params) => output({ jsonrpc: "2.0", method, params }));
setInterval(() => output({ jsonrpc: "2.0", method: "qq/tick", params: {} }), 15000).unref();
readline.createInterface({ input: process.stdin }).on("line", async line => {
  let request;
  try { request = JSON.parse(line); } catch { output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
  if (request.id === undefined) return;
  try {
    const result = await bridge.request(request.method, request.params || {}, request.cindy?.secrets);
    output({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    // Never serialize SDK error messages, HTTP bodies or credential values.
    if (error.code === "METHOD_NOT_FOUND") { output({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }); return; }
    const code = ["QQ_SECRET_REQUIRED", "QQ_NOT_CONNECTED", "INVALID_REPLY", "REPLY_CONFLICT", "QQ_SEND_UNCERTAIN", "BOT_CONFIG_INVALID", "BOT_APP_DUPLICATE", "INVALID_GROUP_MESSAGE", "GROUP_MESSAGE_CONFLICT"].includes(error.code) || /^(IMAGE_[A-Z_]+|QQ_API_\d{3,10}|QQ_HTTP_4\d\d)$/.test(error.code || "") ? error.code : "QQ_REQUEST_FAILED";
    output({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: code } });
  }
});
process.stdin.on("end", () => { bridge.disconnect(); process.exit(0); });
process.on("SIGTERM", () => { bridge.disconnect(); process.exit(0); });
