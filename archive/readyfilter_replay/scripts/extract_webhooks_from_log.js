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

  // quote bare keys: secret: -> "secret":
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

  const startMs = startIso ? new Date(startIso).getTime() : null;
  const endMs = endIso ? new Date(endIso).getTime() : null;

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

  console.log(`Extracted ${events.length} webhook events`);
  console.log(`Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Extraction failed:", err);
  process.exit(1);
});
