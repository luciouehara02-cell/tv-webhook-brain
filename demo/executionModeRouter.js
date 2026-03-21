import { CONFIG } from "./config.js";
import { build3CommasEnterLongSignal, build3CommasExitLongSignal } from "./signalBuilder.js";
import { sendSignalTo3Commas } from "./threeCommasClient.js";
import { checkLiveEntryGuardrails, checkLiveExitGuardrails } from "./liveGuardrails.js";

export async function executeEnterLong(state) {
  const signal = build3CommasEnterLongSignal(state);

  if (CONFIG.LOG_SIGNAL_PAYLOADS) {
    console.log(`📦 SIGNAL PREVIEW ENTER | ${JSON.stringify(signal)}`);
  }

  if (CONFIG.EXECUTION_MODE === "dry_run") {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      guardrailReason: "dry_run_mode",
      signalPayload: signal,
      logLine: "🧪 EXEC MODE | dry_run | no live order sent",
    };
  }

  const guard = checkLiveEntryGuardrails(state);

  if (!guard.allowed) {
    return {
      mode: "live",
      ok: false,
      sent: false,
      guardrailReason: guard.reason,
      eventKey: guard.eventKey,
      signalPayload: signal,
      logLine: `⚠️ LIVE ENTRY BLOCKED | ${guard.reason}`,
    };
  }

  const result = await sendSignalTo3Commas(signal);

  return {
    mode: "live",
    ok: result.ok,
    sent: !result.skipped,
    result,
    guardrailReason: guard.reason,
    eventKey: guard.eventKey,
    signalPayload: signal,
    logLine: result.skipped
      ? `⚠️ LIVE ENTRY SKIPPED | ${result.reason}`
      : `📨 LIVE ENTRY SENT | status=${result.status} | ok=${result.ok ? 1 : 0}`,
  };
}

export async function executeExitLong(state) {
  const signal = build3CommasExitLongSignal(state);

  if (CONFIG.LOG_SIGNAL_PAYLOADS) {
    console.log(`📦 SIGNAL PREVIEW EXIT | ${JSON.stringify(signal)}`);
  }

  if (CONFIG.EXECUTION_MODE === "dry_run") {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      guardrailReason: "dry_run_mode",
      signalPayload: signal,
      logLine: "🧪 EXEC MODE | dry_run | no live exit sent",
    };
  }

  const guard = checkLiveExitGuardrails(state);

  if (!guard.allowed) {
    return {
      mode: "live",
      ok: false,
      sent: false,
      guardrailReason: guard.reason,
      eventKey: guard.eventKey,
      signalPayload: signal,
      logLine: `⚠️ LIVE EXIT BLOCKED | ${guard.reason}`,
    };
  }

  const result = await sendSignalTo3Commas(signal);

  return {
    mode: "live",
    ok: result.ok,
    sent: !result.skipped,
    result,
    guardrailReason: guard.reason,
    eventKey: guard.eventKey,
    signalPayload: signal,
    logLine: result.skipped
      ? `⚠️ LIVE EXIT SKIPPED | ${result.reason}`
      : `📨 LIVE EXIT SENT | status=${result.status} | ok=${result.ok ? 1 : 0}`,
  };
}
