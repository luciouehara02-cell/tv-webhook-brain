import { CONFIG } from "./config.js";
import {
  build3CommasEnterLongSignal,
  build3CommasExitLongSignal,
} from "./signalBuilder.js";
import { sendSignalTo3Commas } from "./threeCommasClient.js";
import {
  checkLiveEntryGuardrails,
  checkLiveExitGuardrails,
} from "./liveGuardrails.js";

function isDryRunMode() {
  return CONFIG.EXECUTION_MODE !== "live" || !CONFIG.LIVE_EXECUTION_ENABLED;
}

function missingSignalFields(signal) {
  const missing = [];
  if (!signal?.secret) missing.push("secret");
  if (!signal?.bot_uuid) missing.push("bot_uuid");
  if (!signal?.action) missing.push("action");
  if (!signal?.tv_exchange) missing.push("tv_exchange");
  if (!signal?.tv_instrument) missing.push("tv_instrument");
  if (!signal?.trigger_price) missing.push("trigger_price");
  return missing;
}

export async function executeEnterLong(state) {
  const signal = build3CommasEnterLongSignal(state);

  if (CONFIG.LOG_SIGNAL_PAYLOADS) {
    console.log(`📦 SIGNAL PREVIEW ENTER | ${JSON.stringify(signal)}`);
  }

  if (isDryRunMode()) {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      guardrailReason: "dry_run_mode",
      signalPayload: signal,
      logLine: "🧪 EXEC MODE | dry_run | no live order sent",
    };
  }

  const missing = missingSignalFields(signal);
  if (missing.length) {
    return {
      mode: "live",
      ok: false,
      sent: false,
      guardrailReason: `missing signal fields: ${missing.join(", ")}`,
      signalPayload: signal,
      logLine: `⚠️ LIVE ENTRY BLOCKED | missing signal fields: ${missing.join(", ")}`,
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
    sent: !!result.ok && !result.skipped,
    result,
    guardrailReason: guard.reason,
    eventKey: guard.eventKey,
    signalPayload: signal,
    logLine: result.skipped
      ? `⚠️ LIVE ENTRY SKIPPED | ${result.reason}`
      : result.ok
        ? `📨 LIVE ENTRY SENT | status=${result.status} | ok=1`
        : `❌ LIVE ENTRY FAILED | status=${result.status} | ok=0`,
  };
}

export async function executeExitLong(state, exitReason = "exit_long") {
  const signal = build3CommasExitLongSignal(state, exitReason);

  if (CONFIG.LOG_SIGNAL_PAYLOADS) {
    console.log(`📦 SIGNAL PREVIEW EXIT | ${JSON.stringify(signal)}`);
  }

  if (isDryRunMode()) {
    return {
      mode: "dry_run",
      ok: true,
      sent: false,
      guardrailReason: "dry_run_mode",
      signalPayload: signal,
      logLine: "🧪 EXEC MODE | dry_run | no live exit sent",
    };
  }

  const missing = missingSignalFields(signal);
  if (missing.length) {
    return {
      mode: "live",
      ok: false,
      sent: false,
      guardrailReason: `missing signal fields: ${missing.join(", ")}`,
      signalPayload: signal,
      logLine: `⚠️ LIVE EXIT BLOCKED | missing signal fields: ${missing.join(", ")}`,
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
    sent: !!result.ok && !result.skipped,
    result,
    guardrailReason: guard.reason,
    eventKey: guard.eventKey,
    signalPayload: signal,
    logLine: result.skipped
      ? `⚠️ LIVE EXIT SKIPPED | ${result.reason}`
      : result.ok
        ? `📨 LIVE EXIT SENT | status=${result.status} | ok=1`
        : `❌ LIVE EXIT FAILED | status=${result.status} | ok=0`,
  };
}
