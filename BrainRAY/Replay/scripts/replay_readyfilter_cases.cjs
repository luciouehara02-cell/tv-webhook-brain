import fs from "fs/promises";

const TARGET_URL = process.env.REPLAY_URL || "http://127.0.0.1:8080/webhook";
const DEFAULT_DELAY_MS = Number(process.env.REPLAY_DELAY_MS || "150");
const REALTIME_MODE = String(process.env.REPLAY_REALTIME || "false").toLowerCase() === "true";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMs(t) {
  const x = new Date(t).getTime();
  return Number.isFinite(x) ? x : null;
}

async function postEvent(event, index, total) {
  const resp = await fetch(TARGET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  let bodyText = "";
  try {
    bodyText = await resp.text();
  } catch {
    bodyText = "";
  }

  const kind =
    event.src === "tick"
      ? "tick"
      : event.src === "ray"
      ? `ray_${String(event.side || "").toLowerCase()}`
      : event.intent || event.action || "unknown";

  console.log(
    `[${index + 1}/${total}] ${kind} time=${event.time || event.timestamp || "na"} status=${resp.status} resp=${bodyText}`
  );
}

async function replayFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const events = JSON.parse(raw);

  if (!Array.isArray(events)) {
    throw new Error("Replay file must be a JSON array");
  }

  console.log(`\n▶ Replaying ${filePath}`);
  console.log(`Events: ${events.length}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Realtime mode: ${REALTIME_MODE}`);
  console.log(`Default delay: ${DEFAULT_DELAY_MS} ms\n`);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    await postEvent(ev, i, events.length);

    if (i === events.length - 1) break;

    let delayMs = DEFAULT_DELAY_MS;

    if (REALTIME_MODE) {
      const nowTs = toMs(ev.time || ev.timestamp);
      const nextTs = toMs(events[i + 1].time || events[i + 1].timestamp);
      if (nowTs != null && nextTs != null && nextTs > nowTs) {
        delayMs = Math.max(0, nextTs - nowTs);
      }
    }

    await sleep(delayMs);
  }

  console.log(`\n✅ Replay complete: ${filePath}\n`);
}

async function main() {
  const files = process.argv.slice(2);

  if (!files.length) {
    console.error("Usage: node replay_readyfilter_cases.js <file1.json> [file2.json...]");
    process.exit(1);
  }

  for (const file of files) {
    await replayFile(file);
  }
}

main().catch((err) => {
  console.error("Replay failed:", err);
  process.exit(1);
});
