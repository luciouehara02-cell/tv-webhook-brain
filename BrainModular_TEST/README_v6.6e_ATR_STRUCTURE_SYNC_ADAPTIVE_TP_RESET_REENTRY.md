# BrainModular v6.6e ATR_STRUCTURE_SYNC_ADAPTIVE_TP_RESET_REENTRY DEMO

Base: v6.6d Adaptive TP DEMO.

New in v6.6e:

- Keeps v6.6d adaptive TP ladder and one-bar pullback TP.
- Adds post-adaptive-TP reentry reset/reclaim gate.
- Blocks immediate reentry after adaptive TP exit.
- Extends adaptive-TP reentry window so the bot can wait for deeper reset and later reclaim.
- Default reset waits for either 0.70% pullback from peak, 0.45% from exit, or EMA18 touch. EMA8-only touch is disabled by default to avoid shallow immediate reentry.

Expected new logs:

```text
🔁 POST_ADAPTIVE_TP_WAIT_RESET
🔁 POST_ADAPTIVE_TP_RESET_SEEN
🔁 POST_ADAPTIVE_TP_RECLAIM_CHECK
🟩🟢 ENTER_LONG reason="post_adaptive_tp_reset_reclaim"
```

Use on DEMO first only.

## v6.6e-fix1 — Tier1 force-giveback env alias fix

Problem found in Test 3: replay env had `DYNAMIC_TP_TIER1_FORCE_GIVEBACK_PCT="0.40"`, but the code was only reading the older long name `DYNAMIC_TP_TIER1_FORCE_EXIT_GIVEBACK_PCT`, so the runtime decision still used default `0.30`.

Fix:
- `src/config.js` now supports both names:
  - `DYNAMIC_TP_TIER1_FORCE_GIVEBACK_PCT`
  - `DYNAMIC_TP_TIER1_FORCE_EXIT_GIVEBACK_PCT`
- `src/config.js` also supports both minimum-exit names:
  - `DYNAMIC_TP_TIER1_FORCE_MIN_EXIT_PNL_PCT`
  - `DYNAMIC_TP_TIER1_MIN_EXIT_PNL_PCT`
- `server.js` startup `CONFIG_SNAPSHOT` now prints `dynamicTpTier1Force` so replay/live logs confirm the loaded values.

Expected Test 3 verification after redeploy:
- Startup log should show `dynamicTpTier1Force.givebackPct: 0.4`.
- The first trade should not exit at `pnlGiveback: 0.3016`, because `0.3016 < 0.40`.
