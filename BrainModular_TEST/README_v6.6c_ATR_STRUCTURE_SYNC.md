# BrainRAY Continuation v6.6c ATR_STRUCTURE_SYNC DEMO

Base: v6.6b ATR_STRUCTURE_SYNC_DEMO.

## What changed in v6.6c

### Entry-side fix

Fixes the race where Ray BUY arrives before the fresh 5m feature bar and the bot arms first-entry confirmation instead of entering.

New behavior:

1. If first-entry confirm is armed and a fresh/strong feature arrives within the grace window, the bot can upgrade confirm -> immediate entry.
2. If the setup remains in confirm mode but the fresh feature is strong, only 1 tick above confirm price is required.
3. Weak/stale confirmation still requires the normal 2 ticks.

Expected new logs:

- `FIRST_ENTRY_CONFIRM_UPGRADE_EVAL`
- `FIRST_ENTRY_CONFIRM_UPGRADED_TO_IMMEDIATE`
- `FIRST_ENTRY_TICK_CONFIRM` with `required: 1` when strong feature is active

### Exit-side v6.6c variable direction

The code still supports ATR/Structure, but the recommended v6.6c variables disable recent-low structure stop:

- `ATR_STRUCTURE_USE_RECENT_LOW=false`

This avoids the May 23 strong reentry problem where structure stop exited too early. ATR stop stays active for first entries and reentries.

## DEMO only

Keep LIVE on v6.5b until v6.6c proves better on DEMO.
