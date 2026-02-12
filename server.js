import express from "express";

const app = express();
app.use(express.json());

let ready = false;
let position = "flat"; // flat / long

app.get("/", (req, res) => {
  res.send("Brain v2 simulation running");
});

app.post("/webhook", (req, res) => {
  console.log("==== NEW WEBHOOK ====");
  console.log(req.body);

  const data = req.body;

  /*
  READY SIGNAL
  */
  if (data.action === "ready") {
    ready = true;
    console.log("🟢 READY ON");
    return res.send("OK");
  }

  /*
  RAYALGO SIGNALS
  */
  if (data.src === "ray") {
    console.log("Ray side:", data.side);

    if (data.side === "BUY") {
      if (!ready) {
        console.log("⛔ BUY blocked (not ready)");
      } else if (position === "long") {
        console.log("⛔ BUY blocked (already in trade)");
      } else {
        console.log("🚀 ENTRY WOULD HAPPEN");
        position = "long";
        ready = false;
      }
    }

    if (data.side === "SELL") {
      if (position === "flat") {
        console.log("⛔ SELL blocked (no position)");
      } else {
        console.log("🟥 EXIT WOULD HAPPEN");
        position = "flat";
      }
    }
  }

  res.send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on", port));
