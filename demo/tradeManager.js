import { CONFIG } from "./config.js";
import {
  buildInitialStop,
  shouldMoveToBreakEven,
  calcTrailingStop,
  calcProfitLockStop,
  checkExitTrigger,
} from "./stopEngine.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function onEntryPositionPatch(state) {
  const initialStop = buildInitialStop(state);

  return {
    peak
