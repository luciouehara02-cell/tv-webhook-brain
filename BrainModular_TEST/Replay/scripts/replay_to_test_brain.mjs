#!/usr/bin/env node
/**
 * Replay JSONL webhook events into a Railway TEST brain.
 * Usage:
 *   TEST_BRAIN_WEBHOOK_URL=https://<test-brain>.up.railway.app/webhook \
 *   TEST_BRAIN_RESET_URL=https://<test-brain>.up.railway.app/reset \
 *   REPLAY_SECRET=TEST_REPLAY_SECRET \
 *   node replay_to_test_brain.mjs ./v6_7a_TEST2_replay_events_May28_31_full.jsonl
 */
import fs from "node:fs";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const file = process.argv[2] || process.env.REPLAY_FILE || "./v6_7a_TEST2_replay_events_May28_31_full.jsonl";
const webhookUrl = process.env.TEST_BRAIN_WEBHOOK_URL;
const resetUrl = process.env.TEST_BRAIN_RESET_URL || (webhookUrl ? webhookUrl.replace(/\/webhook\/?$/, "/reset") : "");
const secret = process.env.REPLAY_SECRET || process.env.WEBHOOK_SECRET || "";
const dryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const maxEvents = Number(process.env.MAX_EVENTS || "0");
const startAt = process.env.START_AT || "";
const endAt = process.env.END_AT || "";
const throttleMs = Number(process.env.REPLAY_THROTTLE_MS || "0");
const resetFirst = String(process.env.REPLAY_RESET_FIRST || "true").toLowerCase() !== "false";
const logEvery = Number(process.env.REPLAY_LOG_EVERY || "500");
const failFast = String(process.env.REPLAY_FAIL_FAST || "true").toLowerCase() !== "false";

if (!dryRun && !webhookUrl) {
  console.error("Missing TEST_BRAIN_WEBHOOK_URL. Example: https://<test-brain>.up.railway.app/webhook");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`Replay file not found: ${file}`);
  process.exit(2);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { ok: res.ok, status: res.status, text, json };
}

function inWindow(eventTime) {
  if (startAt && eventTime < startAt) return false;
  if (endAt && eventTime > endAt) return false;
  return true;
}

async function main() {
  console.log(`Replay file: ${file}`);
  console.log(`Webhook: ${webhookUrl || "DRY_RUN"}`);
  console.log(`Reset first: ${resetFirst}`);
  console.log(`Window: ${startAt || "BEGIN"} -> ${endAt || "END"}`);
  console.log(`Max events: ${maxEvents || "ALL"}`);

  if (!dryRun && resetFirst && resetUrl) {
    const reset = await postJson(resetUrl, { reason: "railway_replay_start" });
    console.log(`Reset status=${reset.status} body=${reset.text.slice(0, 200)}`);
    if (!reset.ok && failFast) process.exit(3);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let seen = 0, sent = 0, skipped = 0, failed = 0;
  const byKind = {};

  for await (const line of rl) {
    if (!line.trim()) continue;
    seen += 1;
    let rec;
    try { rec = JSON.parse(line); } catch (err) { failed += 1; console.error(`Bad JSON line ${seen}: ${err.message}`); if (failFast) process.exit(4); continue; }
    const eventTime = rec.eventTime || rec.payload?.time || rec.replayReceivedAt || "";
    if (!inWindow(eventTime)) { skipped += 1; continue; }
    const payload = { ...(rec.payload || rec) };
    if (secret) payload.secret = secret;
    if (dryRun) {
      sent += 1;
    } else {
      const res = await postJson(webhookUrl, payload);
      if (!res.ok) {
        failed += 1;
        console.error(`FAIL line=${seen} kind=${rec.kind} time=${eventTime} status=${res.status} body=${res.text.slice(0, 300)}`);
        if (failFast) process.exit(5);
      } else {
        sent += 1;
      }
    }
    byKind[rec.kind || payload.src || "unknown"] = (byKind[rec.kind || payload.src || "unknown"] || 0) + 1;
    if (sent % logEvery === 0) console.log(`sent=${sent} skipped=${skipped} failed=${failed} last=${eventTime}`);
    if (throttleMs > 0) await sleep(throttleMs);
    if (maxEvents > 0 && sent >= maxEvents) break;
  }
  console.log("Replay complete", { seen, sent, skipped, failed, byKind });
  if (failed > 0) process.exit(6);
}

main().catch((err) => { console.error(err); process.exit(9); });
