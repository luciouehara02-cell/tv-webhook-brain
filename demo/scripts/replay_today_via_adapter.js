import fs from "fs";
import { buildBrainForReplay } from "../src/brain.js";
// make this whatever factory/init function you already have

const INPUT = process.argv[2] || "./replay_today_2026_03_23.json";
const bars = JSON.parse(fs.readFileSync(INPUT, "utf8"));

const brain = buildBrainForReplay();

for (const bar of bars) {
  const result = await brain.handleEvent(bar); // adapt to your real API

  if (
    result?.validation ||
    result?.transition ||
    result?.entry ||
    result?.exit
  ) {
    console.log(JSON.stringify({
      time: bar.time,
      close: bar.close,
      phase: result?.breakout?.phase,
      score: result?.breakout?.score,
      allowed: result?.validation?.allowed,
      reasons: result?.validation?.reasons,
      action: result?.action ?? null,
    }));
  }
}
