import WebSocket from "ws";
import { config } from "./config.js";
import { agentInstructions } from "./agentPrompt.js";
import { logEvent } from "./logger.js";
import { realtimeTools, runTool } from "./tools.js";

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function handleRealtimeToolCall(event, openaiWs) {
  const { name, call_id: callId } = event.item;
  const args = safeJsonParse(event.item.arguments);

  try {
    const output = await runTool(name, args);
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    }));
  } catch (error) {
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ error: error.message })
      }
    }));
  }

  openaiWs.send(JSON.stringify({ type: "response.create" }));
}

function openAIHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${config.openai.apiKey}`,
    ...extra
  };
}

export async function acceptOpenAISipCall(callId) {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
    method: "POST",
    headers: openAIHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify({
      type: "realtime",
      model: config.openai.realtimeModel,
      instructions: agentInstructions,
      voice: config.openai.voice,
      tools: realtimeTools,
      tool_choice: "auto"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI SIP accept failed ${response.status}: ${body}`);
  }

  return response.json().catch(() => ({ ok: true }));
}

export function monitorOpenAISipCall(callId) {
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    {
      headers: openAIHeaders()
    }
  );

  openaiWs.on("open", () => {
    logEvent("openai_sip_sideband_open", { callId });
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Di esattamente: Expocar, buongiorno, sono Marco. In cosa posso esserle utile?"
      }
    }));
  });

  openaiWs.on("message", async (raw) => {
    const event = safeJsonParse(raw);

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await handleRealtimeToolCall(event, openaiWs);
    }
  });

  openaiWs.on("error", (error) => {
    logEvent("openai_sip_sideband_error", {
      callId,
      message: error.message,
      code: error.code
    });
  });

  openaiWs.on("close", () => {
    logEvent("openai_sip_sideband_close", { callId });
  });
}

export function bridgeTwilioToOpenAI(twilioWs) {
  let streamSid;
  let audioDeltaCount = 0;
  let responseInProgress = false;

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`,
    {
      headers: openAIHeaders()
    }
  );

  openaiWs.on("open", () => {
    logEvent("openai_realtime_open");
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: config.openai.realtimeModel,
        instructions: agentInstructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              interrupt_response: true
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: config.openai.voice
          }
        },
        tools: realtimeTools,
        tool_choice: "auto"
      }
    }));

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: "Di esattamente, con voce naturale e ritmo spedito: Expocar, buongiorno, sono Marco. In cosa posso esserle utile?"
      }
    }));
  });

  twilioWs.on("message", (raw) => {
    const message = safeJsonParse(raw);

    if (message.event === "start") {
      streamSid = message.start?.streamSid;
      logEvent("twilio_media_start", { streamSid });
      return;
    }

    if (message.event === "media" && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: message.media.payload
      }));
    }

    if (message.event === "stop") {
      logEvent("twilio_media_stop", { streamSid });
      openaiWs.close();
    }
  });

  openaiWs.on("message", async (raw) => {
    const event = safeJsonParse(raw);

    if (event.type === "error") {
      logEvent("openai_realtime_server_error", {
        error: event.error
      });
      return;
    }

    if (event.type === "session.created" || event.type === "session.updated" || event.type === "response.created") {
      logEvent("openai_realtime_event", { eventType: event.type });
    }

    if (event.type === "response.created") {
      responseInProgress = true;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      logEvent("openai_speech_started", { responseInProgress });
      if (responseInProgress && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "response.cancel" }));
      }
      if (streamSid) {
        twilioWs.send(JSON.stringify({
          event: "clear",
          streamSid
        }));
      }
      return;
    }

    const audioDelta = event.delta || event.audio;
    if ((
      event.type === "response.output_audio.delta"
      || event.type === "response.audio.delta"
      || event.type === "response.audio.delta"
    ) && audioDelta && streamSid) {
      audioDeltaCount += 1;
      if (audioDeltaCount <= 3) {
        logEvent("openai_audio_delta", { count: audioDeltaCount, eventType: event.type });
      }
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: audioDelta }
      }));
      return;
    }

    if (event.type === "response.done") {
      responseInProgress = false;
      logEvent("openai_response_done", {
        status: event.response?.status,
        statusDetails: event.response?.status_details,
        outputTypes: event.response?.output?.map((item) => item.type)
      });
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await handleRealtimeToolCall(event, openaiWs);
    }
  });

  openaiWs.on("error", (error) => {
    logEvent("openai_realtime_error", {
      message: error.message,
      code: error.code
    });
  });

  twilioWs.on("error", (error) => {
    logEvent("twilio_media_error", {
      message: error.message,
      code: error.code
    });
  });

  twilioWs.on("close", () => openaiWs.close());
  openaiWs.on("close", () => twilioWs.close());
}
