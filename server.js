import express from "express";

const app = express();
app.use(express.json());

/*
  MEMORY
*/
let rayReady = false;
let raySide = null;

/*
  WEBHOOK RECEIVER
*/
app.post("/webhook", async (req, res) => {
  const data = req.body;

  console.log("==== NEW WEBHOOK ====");
  console.log(JSON.stringify(data, null, 2));

  try {
    // ==========================
    // READY
    // ==========================
    if (data.action === "ready") {
      rayReady = true;
      raySide = null;
      console.log("BOT ARMED");
      return res.send("READY OK");
    }

    // ==========================
    // 3COMMAS BUY
    // ==========================
    if (data.action === "enter_long") {
      if (!rayReady) {
        console.log("BLOCKED: not ready");
        return res.send("BLOCKED");
      }

      if (raySide === "BUY") {
        console.log("BLOCKED: already long");
        return res.send("BLOCKED");
      }

      raySide = "BUY";
      rayReady = false;

      console.log("BUY ACCEPTED");
      return res.send("BUY OK");
    }

    // ==========================
    // 3COMMAS SELL
    // ==========================
    if (data.action === "exit_long") {
      raySide = null;
      rayReady = false;
      console.log("SELL ACCEPTED");
      return res.send("SELL OK");
    }

    // ==========================
    // RAY BUY
    // ==========================
    if (data.src === "ray" && data.side === "BUY") {
      if (!rayReady) {
        console.log("BLOCKED: not ready");
        return res.send("BLOCKED");
      }

      if (raySide === "BUY") {
        console.log("BLOCKED: already long");
        return res.send("BLOCKED");
      }

      raySide = "BUY";
      rayReady = false;

      console.log("RAY BUY ACCEPTED");
      return res.send("OK");
    }

    // ==========================
    // RAY SELL
    // ==========================
    if (data.src === "ray" && data.side === "SELL") {
      raySide = null;
      rayReady = false;
      console.log("RAY SELL ACCEPTED");
      return res.send("OK");
    }

    return res.send("IGNORED");
  } catch (err) {
    console.log(err);
    return res.status(500).send("ERROR");
  }
});

app.get("/", (req, res) => {
  res.send("TV Webhook Brain running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
