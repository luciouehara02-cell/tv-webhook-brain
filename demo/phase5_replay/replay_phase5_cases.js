import fs from "fs/promises";

const WEBHOOK_URL =
  "https://demophase5-production.up.railway.app/webhook";
const SECRET = "Demo_brainPhase5_secret_3x9KpL8zQ2mN7wR4tY6uF1";

const CASE_FILES = [ "./case1_clean_winner.json",];
  // "./case1_clean_winner.json",
  //"./case2_fast_failure.json",
  //"./case3_retest_no_bounce.json",
  //"./case4_late_extension.json",
  //"./case5_hostile_context.json",


const STEP_DELAY_MS = 1200;
const CASE_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCase(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const arr = JSON.parse(raw);

  if (!Array.isArray(arr)) {
    throw new Error(`${filePath} must contain a JSON array`);
  }

  return arr.map((p) => ({
    ...p,
    secret: SECRET,
  }));
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

async function runCase(filePath) {
  const payloads = await loadCase(filePath);
  const caseName = filePath.replace("./", "").replace(".json", "");

  console.log(`\n==============================`);
  console.log(`▶ Running ${caseName}`);
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
  console.log("▶ Starting Brain Phase 5 replay suite...");

  for (let i = 0; i < CASE_FILES.length; i += 1) {
    await runCase(CASE_FILES[i]);
    if (i < CASE_FILES.length - 1) {
      console.log(`⏳ Waiting ${CASE_DELAY_MS}ms before next case...\n`);
      await sleep(CASE_DELAY_MS);
    }
  }

  console.log("\n✅ Replay suite complete.");
}

main().catch((err) => {
  console.error("❌ Replay suite failed:", err);
});
