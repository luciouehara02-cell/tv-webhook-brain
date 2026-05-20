# BrainRAY Continuation v6.5a Modular

Base: v6.4 modular No Progress Protection + Thesis Failure Exit.

New in v6.5a:
- Strong-trend BE profit lock after Tier-1 area (`DYNAMIC_BE_STRONG_LOCK_*`)

1. Dynamic Breakeven
   - keeps the existing fixed hard stop and v6.4 defensive exits unchanged
   - moves breakeven earlier for weak/choppy context
   - keeps normal breakeven for normal trades
   - gives strong RSI/ADX trend more room before arming breakeven
   - log when armed: `🛡️ DYNAMIC_BREAKEVEN_ARMED`

Default test profile:

```text
weak   -> BE arm +0.30%, offset +0.03%
normal -> BE arm +0.40%, offset +0.05%
strong -> BE arm +0.50%, offset +0.05%
```

Recommended TEST settings are in `BrainModular_v6.5a_variables_delta.env`.

Run checks:

```bash
cd BrainModular_v6.5a
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
