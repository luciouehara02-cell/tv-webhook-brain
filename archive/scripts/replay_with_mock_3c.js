#!/usr/bin/env node
/**
 * replay_with_mock_3c.js
 *
 * Starts a local mock 3Commas webhook endpoint on :9999
 * so the brain can send enter/exit requests safely during replay.
 *
 * Usage:
 *   node replay_with_mock_3c.js
 */

const http = require("http");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/signal") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      console.log("📦 MOCK 3C:", body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mock: true }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, err: "not found" }));
});

server.listen(9999, () => {
  console.log("✅ Mock 3Commas listening on http://127.0.0.1:9999/signal");
});
