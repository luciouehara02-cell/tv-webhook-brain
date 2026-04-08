#!/usr/bin/env node

/**
 * build_case_from_extracted.cjs
 *
 * Build replay case JSON directly from extracted replay lines like:
 *
 * 2026-04-08T12:24:11.925170211Z  {"src":"features", ...}
 *
 * Usage:
 *   node build_case_from_extracted.cjs \
 *     <input.extracted.log> \
 *     <output.case.json> \
 *     <start_iso> \
 *     <end_iso> \
 *     <secret>
 */

const fs = require("fs");
const path = require("path");

function usage() {
  console.error(
    "Usage: node build_case_from_extracted.cjs <input.extracted.log> <output.case.json> <start_iso> <end_iso> <secret>"
  );
  process.exit(1);
}

if (process.argv.length < 7) usage();

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const startIso = process.argv[4];
const endIso = process.argv[5];
const secret = process.argv[6];

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const startMs = Date.parse(startIso);
const endMs = Date.parse(endIso);

if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
  console.error("Invalid start or end ISO timestamp");
  process.exit(1);
}
if (endMs <= startMs) {
  console.error("End time must be greater than start time");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);

function parseLine(line) {
  // Supports one or more spaces or tabs between timestamp and JSON
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(\{.*\})$/
  );
  if (!m) return null;

  const ts = m[1];
  const jsonStr = m[2];

  let body;
  try {
    body = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;

  return { ts, ms, body };
}

const events = [];

for (const line of lines) {
  const parsed = parseLine(line);
  if (!parsed) continue;
  if (parsed.ms < startMs || parsed.ms > endMs) continue;

  const body = { ...parsed.body };

  // Ensure replayed event carries the secret expected by local brain
  body.secret = secret;

  // Keep a stable event time if missing
  if (!body.time) body.time = parsed.ts;

  events.push(body);
}

const out = {
  createdAt: new Date().toISOString(),
  source: path.basename(inputPath),
  start: startIso,
  end: endIso,
  target: "http://127.0.0.1:8080/webhook",
  realtime: false,
  defaultDelayMs: 150,
  events,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + "\n");

console.log(`Built replay with ${events.length} events`);
console.log(`Saved to ${outputPath}`);
