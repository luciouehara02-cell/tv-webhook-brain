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
