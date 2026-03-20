import { CONFIG } from "./config.js";
import { build3CommasEnterLongSignal, build3CommasExitLongSignal } from "./signalBuilder.js";
import { sendSignalTo3Commas } from "./threeCommasClient.js";

export async function executeEnterLong(state) {
  if (CONFIG.EXECUTION_MODE === "dry_run") {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      logLine: "🧪 EXEC MODE | dry_run | no live order sent",
    };
  }

  const signal = build3CommasEnterLongSignal(state);
  const result = await sendSignalTo3Commas(signal);

  return {
    mode: "live",
    ok: result.ok,
    sent: !result.skipped,
    result,
    logLine: result.skipped
      ? `⚠️ LIVE ENTRY SKIPPED | ${result.reason}`
      : `📨 LIVE ENTRY SENT | status=${result.status} | ok=${result.ok ? 1 : 0}`,
  };
}

export async function executeExitLong(state) {
  if (CONFIG.EXECUTION_MODE === "dry_run") {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      logLine: "🧪 EXEC MODE | dry_run | no live exit sent",
    };
  }

  const signal = build3CommasExitLongSignal(state);
  const result = await sendSignalTo3Commas(signal);

  return {
    mode: "live",
    ok: result.ok,
    sent: !result.skipped,
    result,
    logLine: result.skipped
      ? `⚠️ LIVE EXIT SKIPPED | ${result.reason}`
      : `📨 LIVE EXIT SENT | status=${result.status} | ok=${result.ok ? 1 : 0}`,
  };
}
