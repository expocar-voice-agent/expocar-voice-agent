import "dotenv/config";
import WebSocket from "ws";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY");
}

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
  headers: {
    Authorization: `Bearer ${apiKey}`
  }
});

const timeout = setTimeout(() => {
  console.error("Realtime test timed out");
  ws.close();
  process.exit(1);
}, 15000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      model,
      output_modalities: ["text"],
      instructions: "Rispondi solo con: OK"
    }
  }));

  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Test" }]
    }
  }));

  ws.send(JSON.stringify({
    type: "response.create",
    response: { output_modalities: ["text"] }
  }));
});

ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString());

  if (event.type === "error") {
    clearTimeout(timeout);
    console.error(JSON.stringify(event.error, null, 2));
    ws.close();
    process.exit(1);
  }

  if (event.type === "response.done") {
    clearTimeout(timeout);
    console.log("Realtime OK");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (error) => {
  clearTimeout(timeout);
  console.error(`Realtime connection failed: ${error.code || error.message}`);
  process.exit(1);
});
