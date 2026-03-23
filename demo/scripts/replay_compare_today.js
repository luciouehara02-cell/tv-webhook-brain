import fs from "fs";
import { createInitialState } from "../src/stateStore.js";
import { processFeatureBar as processOld } from "../src/brain_old.js";
import { processFeatureBar as processNew } from "../src/brain.js";
// point brain_old.js to your saved v5.3 baseline, and brain.js to the patched build

const INPUT = process.argv[2] || "./replay_today_2026_03_23.json";
const bars = JSON.parse(fs.readFileSync(INPUT, "utf8"));

const oldState = createInitialState("BINANCE:SOLUSDT", "3");
const newState = createInitialState("BINANCE:SOLUSDT", "3");

for (const bar of bars) {
  processOld(oldState, bar);
  processNew(newState, bar);

  const oldAllowed = oldState.validation?.allowed ?? null;
  const newAllowed = newState.validation?.allowed ?? null;

  const oldPhase = oldState.setups?.breakout?.phase ?? null;
  const newPhase = newState.setups?.breakout?.phase ?? null;

  const flipped =
    oldAllowed !== newAllowed ||
    oldPhase !== newPhase ||
    oldState.position?.inPosition !== newState.position?.inPosition;

  if (flipped) {
    console.log("----");
    console.log(`time=${bar.time} close=${bar.close}`);
    console.log(`OLD phase=${oldPhase} allowed=${oldAllowed} reasons=${(oldState.validation?.reasons ?? []).join("; ")}`);
    console.log(`NEW phase=${newPhase} allowed=${newAllowed} reasons=${(newState.validation?.reasons ?? []).join("; ")}`);
    console.log(`OLD pos=${oldState.position?.inPosition} | NEW pos=${newState.position?.inPosition}`);
  }
}
