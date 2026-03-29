#!/usr/bin/env node
/**
 * replay_with_mock_3c.js
 *
 * ESM version
 *
 * Usage:
 *   node replay_with_mock_3c.js
 */

import http from "http";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/signal") {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

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
