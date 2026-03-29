#!/usr/bin/env node
/**
 * replay_json_to_brain.js
 *
 * ESM version
 *
 * Usage:
 *   node replay_json_to_brain.js replay_20260328.json http://127.0.0.1:8080/webhook
 */

import fs from "fs";

const replayPath = process.argv[2];
const webhookUrl = process.argv[3] || "http://127.0.0.1:8080/webhook";

if (!replayPath) {
  console.error("Usage: node replay_json_to_brain.js <replay.json> <webhookUrl>");
  process.exit(1);
}

const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || "";

const events = JSON.parse(fs.readFileSync(replayPath, "utf8"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postEvent(evt) {
  const body = { ...evt.body };
  const isTick = body.src === "tick";

  const headers = {
    "Content-Type": "application/json",
  };

  if (isTick && TICKROUTER_SECRET) {
    headers["x-webhook-secret"] = TICKROUTER_SECRET;
  } else if (!isTick && WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = WEBHOOK_SECRET;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  let payload = null;
  let text = "";

  try {
    payload = await res.json();
  } catch {
    text = await res.text().catch(() => "");
  }

  return {
    status: res.status,
    payload,
    text,
  };
}

(async () => {
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];

    try {
      const out = await postEvent(evt);

      if (out.status >= 200 && out.status < 300) {
        okCount++;
      } else {
        failCount++;
        console.error(
          `❌ ${i} ${evt.type} ${evt.ts} status=${out.status}`,
          out.payload || out.text
        );
      }

      if ((i + 1) % 100 === 0) {
        console.log(`... replayed ${i + 1}/${events.length}`);
      }

      if (REPLAY_DELAY_MS > 0) {
        await sleep(REPLAY_DELAY_MS);
      }
    } catch (err) {
      failCount++;
      console.error(`❌ ${i} ${evt.type} ${evt.ts} error=${err.message}`);
    }
  }

  console.log("✅ Replay complete");
  console.log({ total: events.length, okCount, failCount });
})();
