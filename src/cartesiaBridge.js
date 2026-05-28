import crypto from "node:crypto";
import WebSocket from "ws";
import { config } from "./config.js";
import { logEvent } from "./logger.js";
import { alertSeller } from "./alerts.js";

const DEMO_TEXT = "Buongiorno, Expocar Italia, sono Marco. Non preoccuparti, penso a tutto io. Dimmi pure che auto stai cercando e ti aiuto subito a trovare la soluzione migliore.";

function sendTwilioAudio(twilioWs, streamSid, payload) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(JSON.stringify({
    event: "media",
    streamSid,
    media: { payload }
  }));
}

function sendTwilioMark(twilioWs, streamSid, name) {
  if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(JSON.stringify({
    event: "mark",
    streamSid,
    mark: { name }
  }));
}

function closeSoon(twilioWs, delayMs = 900) {
  setTimeout(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  }, delayMs);
}

function buildCartesiaUrl() {
  const url = new URL("wss://api.cartesia.ai/tts/websocket");
  url.searchParams.set("cartesia_version", config.cartesia.version);
  return url.toString();
}

function createGenerationRequest(text) {
  return {
    model_id: config.cartesia.modelId,
    transcript: text,
    voice: {
      mode: "id",
      id: config.cartesia.voiceId
    },
    language: "it",
    context_id: crypto.randomUUID(),
    output_format: {
      container: "raw",
      encoding: "pcm_mulaw",
      sample_rate: 8000
    },
    continue: false
  };
}

export function bridgeTwilioToCartesiaDemo(twilioWs) {
  let streamSid = "";
  let cartesiaWs = null;
  let twilioStarted = false;
  let cartesiaOpened = false;
  let generationSent = false;
  const demoText = config.cartesia.demoText || DEMO_TEXT;

  function maybeStartGeneration() {
    if (!twilioStarted || !cartesiaOpened || generationSent) return;
    generationSent = true;
    const request = createGenerationRequest(demoText);
    logEvent("cartesia_demo_generation_start", {
      contextId: request.context_id,
      modelId: request.model_id,
      voiceId: request.voice.id
    });
    cartesiaWs.send(JSON.stringify(request));
  }

  function handleCartesiaMessage(data, isBinary) {
    if (isBinary) {
      sendTwilioAudio(twilioWs, streamSid, Buffer.from(data).toString("base64"));
      return;
    }

    let event;
    try {
      event = JSON.parse(data.toString());
    } catch (error) {
      logEvent("cartesia_demo_unparseable_message", { error: error.message });
      return;
    }

    if (event.type === "chunk" && event.data) {
      sendTwilioAudio(twilioWs, streamSid, event.data);
      return;
    }

    if (event.type === "done" || event.done === true) {
      logEvent("cartesia_demo_done", { contextId: event.context_id });
      sendTwilioMark(twilioWs, streamSid, "cartesia-demo-done");
      closeSoon(twilioWs);
      return;
    }

    if (event.type === "error" || event.status_code >= 400) {
      logEvent("cartesia_demo_error", event);
      alertSeller("cartesia_demo_error", {
        message: event.message || event.error || "Errore Cartesia demo",
        code: event.status_code,
        details: event
      });
      closeSoon(twilioWs, 100);
    }
  }

  if (!config.cartesia.apiKey) {
    logEvent("cartesia_demo_missing_api_key");
    alertSeller("cartesia_demo_missing_api_key", {
      message: "Manca CARTESIA_API_KEY su Render."
    });
    closeSoon(twilioWs, 100);
    return;
  }

  cartesiaWs = new WebSocket(buildCartesiaUrl(), {
    headers: {
      Authorization: `Bearer ${config.cartesia.apiKey}`,
      "X-API-Key": config.cartesia.apiKey,
      "Cartesia-Version": config.cartesia.version
    }
  });

  cartesiaWs.on("open", () => {
    cartesiaOpened = true;
    logEvent("cartesia_demo_open");
    maybeStartGeneration();
  });

  cartesiaWs.on("message", handleCartesiaMessage);

  cartesiaWs.on("error", (error) => {
    logEvent("cartesia_demo_ws_error", { error: error.message });
    alertSeller("cartesia_demo_ws_error", { message: error.message });
    closeSoon(twilioWs, 100);
  });

  cartesiaWs.on("close", (code, reason) => {
    logEvent("cartesia_demo_ws_close", {
      code,
      reason: reason?.toString()
    });
  });

  twilioWs.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.event === "start") {
      streamSid = message.start?.streamSid || "";
      twilioStarted = true;
      logEvent("cartesia_demo_twilio_start", {
        streamSid,
        callSid: message.start?.callSid
      });
      maybeStartGeneration();
    }

    if (message.event === "stop") {
      logEvent("cartesia_demo_twilio_stop", { streamSid });
      if (cartesiaWs?.readyState === WebSocket.OPEN) cartesiaWs.close();
    }
  });

  twilioWs.on("close", () => {
    logEvent("cartesia_demo_twilio_close", { streamSid });
    if (cartesiaWs?.readyState === WebSocket.OPEN) cartesiaWs.close();
  });

  twilioWs.on("error", (error) => {
    logEvent("cartesia_demo_twilio_error", { error: error.message });
    if (cartesiaWs?.readyState === WebSocket.OPEN) cartesiaWs.close();
  });
}
