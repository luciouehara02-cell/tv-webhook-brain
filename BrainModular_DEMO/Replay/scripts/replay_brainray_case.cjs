const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

function sleep(ms) {
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

function parseMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function shiftedIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function getEventTime(ev) {
  return ev.time || ev.timestamp || "";
}

function setEventTime(ev, iso) {
  if ("time" in ev) ev.time = iso;
  if ("timestamp" in ev) ev.timestamp = iso;
  if (!("time" in ev) && !("timestamp" in ev)) ev.time = iso;
}

function buildRewriteEvents(events, defaultDelayMs, minGapMs, maxGapMs) {
  const out = [];
  const baseNow = Date.now();

  for (let i = 0; i < events.length; i++) {
    const ev = clone(events[i]);

    let newMs;
    if (i === 0) {
      newMs = baseNow;
    } else {
      const prevOrig = parseMs(getEventTime(events[i - 1]));
      const currOrig = parseMs(getEventTime(events[i]));

      let gap = defaultDelayMs;
      if (prevOrig != null && currOrig != null) {
        gap = currOrig - prevOrig;
        if (!Number.isFinite(gap) || gap <= 0) gap = defaultDelayMs;
      }

      gap = Math.max(minGapMs, Math.min(maxGapMs, gap));
      const prevNew = parseMs(getEventTime(out[i - 1]));
      newMs = prevNew + gap;
    }

    setEventTime(ev, shiftedIso(newMs));
    out.push(ev);
  }

  return out;
}

async function main() {
  const file = process.argv[2];
  const url = process.argv[3];
  const delayMs = Number(process.argv[4] || process.env.REPLAY_DELAY_MS || 600);
  const mode = String(process.env.REPLAY_TIMESTAMP_MODE || "preserve").toLowerCase();
  const minGapMs = Number(process.env.REPLAY_MIN_GAP_MS || 200);
  const maxGapMs = Number(process.env.REPLAY_MAX_GAP_MS || 300000);

  if (!file || !url) {
    console.error("Usage: node replay_brainray_case.cjs <case.json> <webhook_url> [delay_ms]");
    process.exit(1);
  }

  if (!["preserve", "rewrite"].includes(mode)) {
    console.error(`Invalid REPLAY_TIMESTAMP_MODE="${mode}". Use preserve or rewrite.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, "utf8");
  const originalEvents = JSON.parse(raw);

  const events =
    mode === "rewrite"
      ? buildRewriteEvents(originalEvents, delayMs, minGapMs, maxGapMs)
      : originalEvents.map((e) => clone(e));

  console.log(`Loaded ${events.length} events from ${file}`);
  console.log(`Posting to ${url}`);
  console.log(`Delay between events: ${delayMs} ms`);
  console.log(
    `Timestamp mode: ${
      mode === "preserve"
        ? "preserve original time"
        : "rewrite to now preserving spacing"
    }`
  );

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    console.log(
      `\n[${i + 1}/${events.length}] -> src=${ev.src || ""} event=${ev.event || ""} time=${ev.time || ev.timestamp || ""}`
    );

    const res = await postJson(url, ev);
    console.log(`status=${res.status} body=${res.body}`);

    if (i < events.length - 1) {
      let waitMs = delayMs;

      if (mode === "preserve") {
        const currMs = parseMs(getEventTime(events[i]));
        const nextMs = parseMs(getEventTime(events[i + 1]));
        if (currMs != null && nextMs != null) {
          waitMs = nextMs - currMs;
          if (!Number.isFinite(waitMs) || waitMs <= 0) waitMs = delayMs;
          waitMs = Math.max(minGapMs, Math.min(maxGapMs, waitMs));
        }
      }

      await sleep(waitMs);
    }
  }

  console.log("\nReplay finished.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
