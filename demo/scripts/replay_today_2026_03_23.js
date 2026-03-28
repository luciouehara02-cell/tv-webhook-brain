import fs from "fs";
import { processEvent, getBrainState } from "../brain.js";

const raw = fs.readFileSync("./replay_today.json", "utf8");
const events = JSON.parse(raw);

if (!Array.isArray(events)) {
  throw new Error("replay_today.json must contain an array of events");
}

console.log(`▶️ Replaying ${events.length} events`);

for (let i = 0; i < events.length; i++) {
  const evt = events[i];
  try {
    await processEvent(evt);
  } catch (err) {
    console.error(`❌ Replay failed at index ${i}`);
    console.error("Event:", JSON.stringify(evt));
    throw err;
  }
}

console.log("✅ Replay finished");
console.log(JSON.stringify(getBrainState(), null, 2));
