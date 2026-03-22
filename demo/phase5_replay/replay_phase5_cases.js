import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEBHOOK_URL =
  "https://demophase5-production.up.railway.app/webhook";
const SECRET = "Demo_brainPhase5_secret_3x9KpL8zQ2mN7wR4tY6uF1";

const CASE_MAP = {
  case1: "case1_clean_winner.json",
  case2: "case2_fast_failure.json",
  case3: "case3_retest_no_bounce.json",
  case4: "case4_late_extension.json",
  case5: "case5_hostile_context.json",
};

const STEP_DELAY_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRequestedCase() {
  const requested = process.argv[2]?.trim()?.toLowerCase();

  if (!requested) {
    throw new Error(
      `Missing case argument. Use one of: ${Object.keys(CASE_MAP).join(", ")}`
    );
  }

  const fileName = CASE_MAP[requested];

  if (!fileName) {
    throw new Error(
      `Unknown case "${requested}". Use one of: ${Object.keys(CASE_MAP).join(", ")}`
    );
  }

  return { requested, fileName };
}

async function loadCase(fileName) {
  const fullPath = path.join(__dirname, fileName);
  const raw = await fs.readFile(fullPath, "utf8");
  const arr = JSON.parse(raw);

  if (!Array.isArray(arr)) {
    throw new Error(`${fileName} must contain a JSON array`);
  }

  return {
    fullPath,
    payloads: arr.map((p) => ({
      ...p,
      secret: SECRET,
    })),
  };
}

async function sendPayload(payload, stepIndex, caseName) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  console.log(
    `STEP ${stepIndex + 1} | case=${caseName} | status=${res.status} | response=${text}`
  );
}

async function runCase(requested, fileName) {
  const { fullPath, payloads } = await loadCase(fileName);
  const caseName = fileName.replace(".json", "");

  console.log(`\n==============================`);
  console.log(`▶ Running ${requested} -> ${caseName}`);
  console.log(`USING FILE: ${fileName}`);
  console.log(`FULL PATH: ${fullPath}`);
  console.log(`FIRST BAR TIME: ${payloads[0]?.time}`);
  console.log(`LAST BAR TIME: ${payloads[payloads.length - 1]?.time}`);
  console.log(`TOTAL BARS: ${payloads.length}`);
  console.log(`==============================`);

  for (let i = 0; i < payloads.length; i += 1) {
    const p = payloads[i];
    console.log(
      `📨 ${caseName} | step=${i + 1} | time=${p.time} | close=${p.close} | src=${p.src}`
    );
    await sendPayload(p, i, caseName);
    await sleep(STEP_DELAY_MS);
  }

  console.log(`✅ Finished ${caseName}`);
}

async function main() {
  const { requested, fileName } = resolveRequestedCase();

  console.log("▶ Starting Brain Phase 5 replay...");
  await runCase(requested, fileName);
  console.log("\n✅ Replay complete.");
}

main().catch((err) => {
  console.error("❌ Replay failed:", err.message || err);
  process.exit(1);
});
