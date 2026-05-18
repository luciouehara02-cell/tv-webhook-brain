# BrainRAY Continuation v6.4 Modular

Base: v6.3 modular first-entry fail-fast build.

New in v6.4:

1. First Entry No Progress Protection
   - first-entry modes only
   - exits when the trade has not reached a minimum peak profit after a configurable bar window and momentum/support weaken
   - exit reason: `first_entry_no_progress`

2. First Entry Thesis Failure Exit
   - first-entry modes only
   - exits when original bullish thesis fails: losing trade, RSI weak, close below required support, FVVO not bullish
   - includes `FIRST_ENTRY_THESIS_FAIL_MAX_PEAK_PCT` so a trade that showed some progress is not killed too easily
   - exit reason: `first_entry_thesis_fail`

Recommended TEST settings are in `BrainModular_v6.4_variables_delta.env`.

Run checks:

```bash
cd BrainModular_v6.4
npm install --no-audit --no-fund
npm run check:all
```

Railway start command from repo root:

```bash
node BrainModular_TEST/server.js
```

or if Root Directory is set to `BrainModular_TEST`:

```bash
node server.js
```
