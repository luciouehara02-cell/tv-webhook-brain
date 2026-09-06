# TickRouter AltAssets v1e — destination event filtering

This version retains all existing symbol routing and adds an optional kind filter per destination:

```env
DEST_1_KINDS="fvvo_feature_tick,fvvo_feature_5m,fvvo_fast_tick"
DEST_2_KINDS=""
DEST_3_KINDS="fvvo_feature_tick,fvvo_fast_tick"
```

An empty or absent `DEST_n_KINDS` accepts every supported kind, preserving v1d behavior.

For the current layout, `DEST_1` remains the MultiAsset brain and receives BNB 5m features plus ticks. `DEST_3` is the BNB LongRun brain and receives only tick-family messages for hard-stop/profit protection. LongRun MTF features and Ray events continue directly from TradingView and do not pass through this router.

Accepted values are exactly:

- `fvvo_feature_tick` — `FEATURE_TICK_FVVO`, normally the 15-second feature feed
- `fvvo_feature_5m` — `FEATURE_5M_FVVO`
- `fvvo_fast_tick` — `FAST_TICK_FVVO`

After deployment, open `/routes`. Under `BINANCE:BNBUSDT`, `fvvo_feature_5m` must not list the LongRun destination, while the required tick kind must list it.

Recommended current additions:

```env
ROUTER_NAME="TickRouter_AltAssets_v1e_EVENT_FILTER"
DEST_1_KINDS="fvvo_feature_tick,fvvo_feature_5m,fvvo_fast_tick"
DEST_3_KINDS="fvvo_feature_tick,fvvo_fast_tick"
```

Leave `DEST_2_KINDS` empty unless destination 2 also needs filtering.
