// Scripted-verdict mock of DNey's POST /api/v1/check, for manual dev + smoke.
// Verdict is driven by the text: contains "BLOCKME" -> blocked, "MODIFYME" ->
// modified (redacts the token), otherwise allowed. `node mock/server.mjs`.
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/api/v1/check", (req, res) => {
  const { text = "", direction = "input" } = req.body ?? {};
  let action = "allowed";
  let out = text;
  let rails = [];
  if (/BLOCKME/i.test(text)) {
    action = "blocked";
    out = "This content was blocked by your organization's policy (mock).";
    rails = ["mock_block"];
  } else if (/MODIFYME/i.test(text)) {
    action = "modified";
    out = text.replace(/MODIFYME/gi, "[REDACTED]");
    rails = ["mock_modify"];
  }
  res.json({
    action,
    text: out,
    original_text: text,
    rails_triggered: rails,
    latency_ms: 5,
    _direction: direction,
  });
});

const port = process.env.PORT || 8790;
app.listen(port, () => console.log(`mock DNey listening on http://localhost:${port}`));
