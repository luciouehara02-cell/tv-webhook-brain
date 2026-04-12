const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJson(urlString, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const body = JSON.stringify(data);

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    };

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(opts, (res) => {
      let chunks = "";
      res.on("data", (d) => (chunks += d));
      res.on("end", () => resolve({ status: res.statusCode, body: chunks }));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function shiftedIso(baseMs, offsetMs) {
  return new Date(baseMs + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const file = process.argv[2];
  const url = process.argv[3];
  const delayMs = Number(process.argv[4] || 600);

  if (!file || !url) {
    console.error("Usage: node replay_brainray_case.cjs <case.json> <webhook_url> [delay_ms]");
    process.exit(1);
  }

  const raw = fs.readFileSync(file, "utf8");
  const events = JSON.parse(raw);

  console.log(`Loaded ${events.length} events from ${file}`);
  console.log(`Posting to ${url}`);
  console.log(`Delay between events: ${delayMs} ms`);
  console.log(`Timestamp mode: rewrite to current time`);

  const startMs = Date.now();

  for (let i = 0; i < events.length; i++) {
    const ev = { ...events[i] };

    // Rewrite time/timestamp to "now + sequence offset"
    const eventMs = startMs + i * delayMs;
    if ("time" in ev) ev.time = shiftedIso(startMs, i * delayMs);
    if ("timestamp" in ev) ev.timestamp = shiftedIso(startMs, i * delayMs);

    console.log(
      `\n[${i + 1}/${events.length}] -> src=${ev.src || ""} event=${ev.event || ""} time=${ev.time || ev.timestamp || ""}`
    );

    const res = await postJson(url, ev);
    console.log(`status=${res.status} body=${res.body}`);

    if (i < events.length - 1) {
      await sleep(delayMs);
    }
  }

  console.log("\nReplay finished.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
