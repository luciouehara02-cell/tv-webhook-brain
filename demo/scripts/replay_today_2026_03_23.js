import fs from "fs";
import { createInitialState } from "../src/stateStore.js";
import { processFeatureBar } from "../src/brain.js";
// change the import above to match your actual project

const INPUT = process.argv[2] || "./replay_today_2026_03_23.json";

const bars = JSON.parse(fs.readFileSync(INPUT, "utf8"));
const state = createInitialState("BINANCE:SOLUSDT", "3");

const interesting = [];

for (let i = 0; i < bars.length; i++) {
  const bar = bars[i];

  const beforePhase = state.setups?.breakout?.phase ?? null;
  const beforeAllowed = state.validation?.allowed ?? null;
  const beforeInPos = state.position?.inPosition ?? false;

  processFeatureBar(state, bar);

  const afterPhase = state.setups?.breakout?.phase ?? null;
  const validation = state.validation ?? { allowed: null, reasons: [] };
  const afterInPos = state.position?.inPosition ?? false;

  const changed =
    beforePhase !== afterPhase ||
    beforeAllowed !== validation.allowed ||
    beforeInPos !== afterInPos ||
    validation.allowed === true;

  if (changed) {
    interesting.push({
      i,
      time: bar.time,
      close: bar.close,
      phase: afterPhase,
      score: state.setups?.breakout?.score ?? null,
      allowed: validation.allowed,
      reasons: validation.reasons ?? [],
      inPosition: afterInPos,
      setupId: state.setups?.breakout?.setupId ?? null,
    });
  }
}

console.log("==== REPLAY SUMMARY ====");
for (const row of interesting) {
  console.log(
    [
      row.i.toString().padStart(4, " "),
      row.time,
      `close=${row.close}`,
      `phase=${row.phase}`,
      `score=${row.score}`,
      `allowed=${row.allowed}`,
      `inPos=${row.inPosition}`,
      row.reasons.length ? `reasons=${row.reasons.join("; ")}` : "",
    ].join(" | ")
  );
}

console.log("\nFinal position:", state.position);
console.log("Final breakout:", state.setups?.breakout);
console.log("Final validation:", state.validation);
