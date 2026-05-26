# BrainRAY Continuation v6.6d ATR_STRUCTURE_SYNC_ADAPTIVE_TP DEMO

Base: v6.6c ATR_STRUCTURE_SYNC DEMO.

## Main additions

1. Keeps v6.6c first-entry sync improvements:
   - Ray/feature sync grace.
   - Confirm-to-immediate upgrade when fresh feature arrives after Ray.
   - Strong fresh feature can confirm with 1 tick while weak/stale setups stay at 2 ticks.

2. Keeps ATR / structure exit layer for DEMO:
   - ATR applies to first entries and reentries.
   - Recent-low structure stop remains disabled by default to avoid killing strong reentries too early.

3. Adds TP protection fail-safe:
   - Launch TP Protection can no longer block a TP exit after max giveback, bearish FVVO, or close below EMA8.

4. Adds Adaptive TP ladder:
   - Tracks peak PnL.
   - Higher peak PnL means tighter allowed giveback.
   - First-entry, normal-reentry, and strong-reentry profiles have separate windows.

5. Adds fee-aware TP minimum:
   - Uses FEE_ROUND_TRIP_PCT and SLIPPAGE_BUFFER_PCT to avoid exiting too close to break-even.

## Expected logs

- `🎯 ADAPTIVE_TP_ARMED`
- `🎯 ADAPTIVE_TP_LEVEL_UP`
- `🎯 ADAPTIVE_TP_TRAIL_UPDATE`
- `🎯⚠️ ADAPTIVE_TP_FORCE_EXIT`
- `🟦✅ LAUNCH_TP_PROTECTION_OVERRIDE`
- `🎯⚠️ DYNAMIC_TP_TIER1_FORCE_EXIT`

## Replay validation

Synthetic May 26 replay showed:

- Entry at 85.00.
- Tier 1 armed at +0.6118%.
- Adaptive TP moved to MID level at +0.9294% peak.
- Adaptive TP force-exited when PnL pulled back to +0.5765%.
- Exit reason: `adaptive_tp_first_mid_giveback`.

This prevents the old behavior where Launch TP Protection repeatedly blocked the TP while peak profit gave back too much.
