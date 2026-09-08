TickRouter AltAssets v1f deployment

1. Deploy this directory so the updated file is named exactly server.js.
2. Preserve all existing Railway variables.
3. Add the DEST_4 variables from RAILWAY_ENV_V1F.txt.
4. DEST_4_SECRET must match the standalone BNB service WEBHOOK_SECRET.
5. Redeploy and confirm startup prints:
   Destination 4 STANDALONE_BNB: ... symbols=BINANCE:BNBUSDT
6. A BNB feature tick should then report targets=3.
