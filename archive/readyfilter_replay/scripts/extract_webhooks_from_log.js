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

  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  s = s.replace(/'/g, '"');
  s = s.replace(/,\s*([}\]])/g, "$1");

  return s;
}

function stripLogPrefix(line) {
  return line.replace(/^.*?\[inf\]\s*/, "");
}

function extractBlocks(lines) {
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

  if (src === "tick") return true;
  if (src === "ray" && (side === "BUY" || side === "SELL")) return true;
  if (intent === "enter_long" || intent === "exit_long") return true;
  if (action === "enter_long" || action === "exit_long") return true;

  return false;
}

function getEventTime(obj) {
  return obj.time || obj.timestamp || null;
}

async function main() {
  const [, , inputPath, outputPath, startIso, endIso] = process.argv;

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: node extract_webhooks_from_log.js <input_log.txt> <output.json> [startIso] [endIso]"
    );
    process.exit(1);
  }

  const raw = await fs.readFile(inputPath, "utf8");
  const lines = raw.split(/\r?\n/);

  const blocks = extractBlocks(lines);
  const events = [];

  for (const block of blocks
