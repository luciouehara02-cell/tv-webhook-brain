import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { isoNow } from "./utils.js";
const fresh = () => ({ version: 1, startedAt: isoNow(), phase: "FLAT", frames: { "5": null, "15": null, "60": null, "240": null }, previous: { "5": null, "15": null, "60": null, "240": null }, ray: { "15": null, "60": null }, setup: null, position: null, lastPrice: null, lastTickAt: null, dedup: [], lastEnterMs: 0, lastExitMs: 0, trades: [], counters: { received: 0, rejected: 0, duplicate: 0, entries: 0, exits: 0 }, logs: [] });
export let S = fresh();
export function log(event, data = {}) { const row = { at: isoNow(), event, ...data }; S.logs.push(row); if (S.logs.length > 1000) S.logs.shift(); if (CONFIG.DEBUG) console.log(`${row.at} ${event} | ${JSON.stringify(data)}`); }
export function loadState() { try { const v = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, "utf8")); S = { ...fresh(), ...v }; log("♻️ STATE_RESTORED", { phase: S.phase, inPosition: Boolean(S.position) }); } catch (e) { if (e?.code !== "ENOENT") log("⚠️ STATE_RESTORE_FAILED", { error: String(e.message || e) }); } }
export function saveState() { try { fs.mkdirSync(path.dirname(CONFIG.STATE_FILE), { recursive: true }); const tmp = `${CONFIG.STATE_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(S, null, 2)); fs.renameSync(tmp, CONFIG.STATE_FILE); } catch (e) { log("❌ STATE_SAVE_FAILED", { error: String(e.message || e) }); } }
export function resetState() { S = fresh(); saveState(); log("♻️ STATE_RESET"); }
