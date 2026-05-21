# BrainRAY Continuation v6.6 ATR / Structure Stop DEMO

Base: v6.5a Dynamic Breakeven + Strong Lock.

v6.6 adds an exit-only ATR / structure stop layer. Entry logic is unchanged.

## Main change

- First-entry logic unchanged.
- Dynamic Breakeven unchanged.
- Strong BE Lock unchanged.
- New ATR / structure stop is designed mainly for reentries and strong reentries.
- Default recommended DEMO mode applies ATR/structure stop to reentries only.

## Safety design

For long positions, v6.6 only tightens the active stop. It does not loosen the stop.

Recommended DEMO behavior:

- `ATR_STOP_APPLY_FIRST_ENTRY=false`
- `ATR_STOP_APPLY_REENTRY=true`
- `ATR_STOP_APPLY_OTHER_MODES=false`
- `ATR_STOP_MIN_BARS_AFTER_ENTRY=1`
- `ATR_STOP_MIN_LOSS_TRIGGER_PCT=-0.35`

This keeps first entries behaving like v6.5a and tests ATR mainly on failed reentries.

## Expected new logs

- `🛡️📐 ATR_STRUCTURE_STOP_UPDATED`
- `🛡️📐 ATR_STRUCTURE_STOP_HOLD`
- Exit reason can be `atr_stop` or `structure_stop` when the ATR layer triggers.

## Railway start command

If this folder is inside repository root:

```bash
npm install --no-audit --no-fund && node BrainModular_DEMO/server.js
```

If Railway Root Directory is this folder:

```bash
npm install --no-audit --no-fund && node server.js
```
