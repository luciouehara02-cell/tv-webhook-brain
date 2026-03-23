import fs from "fs";
import { resetState } from "../stateStore.js";
import { processEvent, getBrainState } from "../brain.js";

const INPUT = process.argv[2] || "./replay_today_2026_03_23.json";

const bars = JSON.parse(fs.readFileSync(INPUT, "utf8"));

resetState();

const interesting = [];

for (let i = 0; i < bars.length; i++) {
  const bar = bars[i];

  const before = getBrainState();
  const beforePhase = before.setups?.breakout?.phase ?? null;
  const beforeAllowed = before.validation?.breakout?.allowed ?? null;
  const beforeInPos = before.position?.inPosition ?? false;

  await processEvent(bar);

  const after = getBrainState();
  const afterPhase = after.setups?.breakout?.phase ?? null;
  const validation = after.validation?.breakout ?? { allowed: null, reasons: [] };
  const afterInPos = after.position?.inPosition ?? false;

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
      score: after.setups?.breakout?.score ?? null,
      allowed: validation.allowed,
      reasons: validation.reasons ?? [],
      inPosition: afterInPos,
      setupId: after.setups?.breakout?.setupId ?? null,
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

const finalState = getBrainState();
console.log("\n==== FINAL STATE ====");
console.log(
  JSON.stringify(
    {
      market: finalState.market,
      breakout: finalState.setups?.breakout,
      validation: finalState.validation?.breakout,
      position: finalState.position,
      execution: finalState.execution,
    },
    null,
    2
  )
);
