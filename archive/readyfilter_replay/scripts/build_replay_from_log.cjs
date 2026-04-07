const fs = require("fs/promises");
const path = require("path");

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeObjectLiteralToJson(text) {
  let s = text.trim();

  // quote bare keys
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

  // single quotes -> double quotes
  s = s.replace(/'/g, '"');

  // remove trailing commas
  s = s.replace(/,\s*([}\]])/g, "$1");

  return s;
}

function stripLogPrefix(line) {
  return line.replace(/^.*?\[inf\]\s*/, "");
}

function extractJsonBlocks(lines) {
  const blocks = [];
  let collecting = false;
  let buf = [];
  let depth = 0;

  for (const raw of lines) {
    const line = stripLogPrefix(raw).trimEnd();

    if (!collecting) {
      if (line === "{") {
        collecting = true;
        buf = ["{"];
        depth = 1;
      }
      continue;
    }

    buf.push(line);

    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    if (depth === 0) {
      blocks.push(buf.join("\n"));
      collecting = false;
      buf = [];
    }
  }

  return blocks;
}

function isRelevantWebhook(obj) {
  if (!obj || typeof obj !== "object") return false;

  const src = String(obj.src || "").toLowerCase();
  const intent = String(obj.intent || "").toLowerCase();
  const action = String(obj.action || "").toLowerCase();
  const side = String(obj.side || "").toUpperCase();

  if (src === "ray" && (side === "BUY" || side === "SELL")) return true;
  if (intent === "enter_long" || intent === "exit_long") return true;
  if (action === "enter_long" || action === "exit_long") return true;

  return false;
}

function parseTickSummaryLine(rawLine, secret) {
  const line = stripLogPrefix(rawLine);

  // Example:
  // 🟦 TICK(15s) BINANCE:SOLUSDT price=82.51 time=2026-04-06T02:14:16Z
  const m = line.match(/🟦\s*TICK\(15s\)\s+(\S+)\s+price=([0-9.]+)\s+time=([0-9T:\-.Z]+)/);
  if (!m) return null;

  const [, symbol, price, time] = m;

  return {
    secret,
    src: "tick",
    symbol,
    price: Number(price),
    time,
  };
}

function getEventTime(obj) {
  return obj.time || obj.timestamp || null;
}

async function main() {
  const [, , inputPath, outputPath, startIso, endIso, webhookSecretArg] = process.argv;

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: node build_replay_from_log.cjs <input_log.txt> <output.json> [startIso] [endIso] [webhookSecret]"
    );
    process.exit(1);
  }

  const webhookSecret =
    webhookSecretArg || "CHANGE_ME_TO_RANDOM_40+CHARS_9f8d7c6b5a4e3d2c1b0a";

  const raw = await fs.readFile(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);

  const startMs = startIso ? new Date(startIso).getTime() : null;
  const endMs = endIso ? new Date(endIso).getTime() : null;

  const events = [];

  // 1) Tick summary lines -> tick webhook JSON
  for (const line of lines) {
    const ev = parseTickSummaryLine(line, webhookSecret);
    if (!ev) continue;

    const tMs = new Date(ev.time).getTime();
    if (startMs != null && tMs < startMs) continue;
    if (endMs != null && tMs > endMs) continue;

    events.push(ev);
  }

  // 2) Full webhook JSON blocks -> ray/intents
  const blocks = extractJsonBlocks(lines);

  for (const block of blocks) {
    const normalized = normalizeObjectLiteralToJson(block);
    const obj = safeJsonParse(normalized);
    if (!obj) continue;
    if (!isRelevantWebhook(obj)) continue;

    const t = getEventTime(obj);
    const tMs = t ? new Date(t).getTime() : null;

    if (startMs != null && tMs != null && tMs < startMs) continue;
    if (endMs != null && tMs != null && tMs > endMs) continue;

    events.push(obj);
  }

  events.sort((a, b) => {
    const ta = new Date(getEventTime(a) || 0).getTime();
    const tb = new Date(getEventTime(b) || 0).getTime();
    return ta - tb;
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(events, null, 2), "utf8");

  console.log(`Built replay with ${events.length} events`);
  console.log(`Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Build replay failed:", err);
  process.exit(1);
});
