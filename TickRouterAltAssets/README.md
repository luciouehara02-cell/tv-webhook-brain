# TickRouter AltAssets v1g — Additional ETH v3q 15s/5m destination

This is a **drop-in replacement** for the user-supplied `TickRouter_AltAssets_v1f_STANDALONE_BNB_ROUTE` `server.js`, with a fifth destination. It preserves the existing destination 1-4 code and route semantics. It does not update any Railway environment variables or TradingView alerts automatically.

## Added destination 5

| Router variable | Value |
| --- | --- |
| `DEST_5_URL` | `https://YOUR-REAL-ETH-V3Q.up.railway.app/webhook` |
| `DEST_5_SECRET` | Exact value of **ETH v3q brain** `WEBHOOK_SECRET` |
| `DEST_5_SYMBOLS` | `BINANCE:ETHUSDT` |
| `DEST_5_KINDS` | `fvvo_feature_tick,fvvo_feature_5m` |

`DEST_5_SYMBOLS` and `DEST_5_KINDS` have the shown default values if omitted. Additional code prevents destination 5 from receiving another asset or `fvvo_fast_tick` even if someone accidentally broadens these two ENV variables. The fifth route is disabled unless a valid `DEST_5_URL` is supplied. To forward, `DEST_5_SECRET` must also be set.

Do not modify/remove `DEST_1_*`, `DEST_2_*`, `DEST_3_*`, `DEST_4_*` if they already forward to other brains. Add the ETH destination to the **existing TickRouter Railway service** rather than deploying a parallel router or altering existing TradingView webhook URLs.

### What comes via TickRouter?

- TradingView `FEATURE_TICK_FVVO` from `BINANCE:ETHUSDT` 15s => ETH v3q `/webhook`.
- TradingView `FEATURE_5M_FVVO` from `BINANCE:ETHUSDT` 5m => ETH v3q `/webhook`.
- Existing ETH destinations also continue receiving either event if their own symbol/kind filters include it. This is intended fan-out, but take care that independent ETH brains use independent 3Commas bots/codes and do not control the same position.

### What is NOT forwarded by this router?

- **30m `RAY30_SIGNAL` from the 30m feature publisher**.
- **30m external RayAlgo** `BULLISH_TREND_CHANGE`, `BULLISH_TREND_CONTINUATION`, `BEARISH_TREND_CHANGE`, `BEARISH_TREND_CONTINUATION`.
- Optional 5m `FVVO_SIGNAL` oscillator alerts such as `SNIPER_SELL` and `BURST_BEARISH`.

Send these directly from TradingView to the ETH v3q Railway `/webhook` (using the ETH brain's `WEBHOOK_SECRET`), unless a separate router update explicitly adds support. The current router returns `200` with `ignored: true` for unknown events, so do not interpret a TradingView `200` as evidence of delivery to the brain.

### Secrets

The router's inbound `WEBHOOK_SECRET` authenticates the TradingView => TickRouter request (whenever `WEBHOOK_SECRET` is set, inbound authentication is enforced, regardless of `REQUIRE_INBOUND_SECRET=false`). The router strips that inbound secret and sends each destination's `DEST_N_SECRET`. Therefore, the ETH `DEST_5_SECRET` must exactly match **ETH v3q Railway** `WEBHOOK_SECRET`, not SOL's secret or 3Commas custom codes.

### Safe deployment

1. Leave all currently configured `DEST_1`–`DEST_4` values unchanged.
2. Replace only the **TickRouter** service's `server.js` (retain existing `package.json`, or use the supplied stand-alone one).
3. Add `DEST_5_URL`, `DEST_5_SECRET`, `DEST_5_SYMBOLS`, `DEST_5_KINDS` in that Railway service.
4. Keep `ALLOWED_SYMBOLS` including `BINANCE:ETHUSDT` (the existing source's default does).
5. Deploy, then inspect `GET /health` (`ETH_V3Q_LONGHOLD`: `enabled:true`, `hasSecret:true`) and `GET /routes` to verify that ETH `fvvo_feature_tick` and `fvvo_feature_5m` list `ETH_V3Q_LONGHOLD`. SOL and BNB route lists must be unchanged.
6. Temporarily enable the ETH brain's `LOG_FEATURE_TICK_ENABLED=true`, `LOG_15S_TICK_ENABLED=true`, `LOG_15S_TICK_EVERY_N=1`, `LOG_FEATURE_5M_ENABLED=true`, and confirm `FVVO_FEATURE_TICK_RECEIVED` and `FVVO_FEATURE_5M_RECEIVED` in its actual Railway logs.
7. Use a separate ETH 3Commas DEMO bot and verify it is flat before enabling any automated order forwarding. ETH brain amount: `C3_AMOUNT_PER_TRADE="30"`, `C3_AMOUNT_PER_TRADE_TYPE="quote"`.

### PowerShell — see actual ETH routes

```powershell
$RouterUrl = "https://YOUR-EXISTING-TICKROUTER.up.railway.app"
$Routes = (Invoke-RestMethod "$RouterUrl/routes").routes
$Routes.'BINANCE:ETHUSDT' | ConvertTo-Json -Depth 8
```

Example expected object for the **new** destination (there may also be the existing `PRIMARY_MULTI_SWING` route):

```json
{
  "fvvo_feature_tick": [{"label":"ETH_V3Q_LONGHOLD","url":"https://YOUR-REAL-ETH-V3Q.up.railway.app/webhook"}],
  "fvvo_feature_5m": [{"label":"ETH_V3Q_LONGHOLD","url":"https://YOUR-REAL-ETH-V3Q.up.railway.app/webhook"}]
}
```

### Replay testing

```bash
npm test
```

The test uses a local stub for Express and HTTP requests; it does **not** access live Railway or 3Commas. This version passed 12 routing cases covering ETH/SOL/BNB, 15s/5m fan-out, isolation, secrets and 30m ignored-event behaviour.
