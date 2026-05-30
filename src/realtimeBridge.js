import WebSocket from "ws";
import { config } from "./config.js";
import { agentInstructions } from "./agentPrompt.js";
import { logEvent } from "./logger.js";
import { realtimeTools, runTool } from "./tools.js";
import { saveLead } from "./leads.js";
import { notifySeller, sendCustomerAfterCallWhatsapp } from "./whatsapp.js";
import { alertSeller } from "./alerts.js";

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clipText(value, maxLength = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizeLeadText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function updateLeadFacts(session, speaker, text) {
  if (speaker !== "Cliente") return;
  const clean = clipText(text, 220);
  if (!clean || clean.length < 4) return;

  const normalized = normalizeLeadText(clean);
  const looksForeign = /[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i.test(clean) && !/[àèéìòù]/i.test(clean);
  if (looksForeign) return;

  const mentionsAppointment = /\b(appuntamento|domani|oggi|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|alle\s+\d{1,2}|consulente)\b/.test(normalized);
  const mentionsImport = /\b(import|estero|germania|europa|ordinare|cercare|ricerca|su misura)\b/.test(normalized);
  const mentionsBudget = /\b(budget|euro|prezzo|finanziamento|leasing|permuta|sconto)\b/.test(normalized) || /\d{2,3}\.?\d{3}/.test(normalized);
  const mentionsVehicle = /\b(auto|macchina|vettura|audi|bmw|mercedes|porsche|range|smart|x5|q3|benzina|diesel|ibrida|elettrica|suv)\b/.test(normalized);
  const mentionsSeaNext = /\b(sea\s*next|seanxt|scooter|subacque)\b/.test(normalized);

  if (mentionsAppointment) session.leadFacts.appointment = clean;
  if (mentionsImport) session.leadFacts.importRequest = clean;
  if (mentionsBudget) session.leadFacts.budget = clean;
  if (mentionsVehicle || mentionsSeaNext) session.leadFacts.interest = clean;
  if (!session.leadFacts.request && (mentionsAppointment || mentionsImport || mentionsBudget || mentionsVehicle || mentionsSeaNext)) {
    session.leadFacts.request = clean;
  }
}

function extractTranscript(event) {
  return event.transcript
    || event.item?.transcript
    || event.item?.content?.map((part) => part.transcript || part.text).filter(Boolean).join(" ")
    || event.response?.output?.flatMap((item) => item.content || []).map((part) => part.transcript || part.text).filter(Boolean).join(" ")
    || "";
}

function appendTranscript(session, speaker, text) {
  const clean = clipText(text, 500);
  if (!clean) return;
  session.transcript.push({ speaker, text: clean });
  updateLeadFacts(session, speaker, clean);
  logEvent("call_transcript_piece", {
    callSid: session.callSid,
    speaker,
    text: clean
  });
}

function greetingForRome() {
  const hour = Number(new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    hour: "2-digit",
    hour12: false
  }).format(new Date()));

  if (hour < 13) return "Buongiorno";
  if (hour < 18) return "Buon pomeriggio";
  return "Buonasera";
}

function buildLeadWhatsapp(session) {
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));

  return [
    "Lead ExpoCar",
    `Cliente: ${session.from || "numero non disponibile"}`,
    session.callSid ? `Call SID: ${session.callSid}` : "",
    `Durata circa: ${durationSeconds} sec`,
    session.leadFacts.request ? `Richiesta: ${session.leadFacts.request}` : "",
    session.leadFacts.interest ? `Interesse: ${session.leadFacts.interest}` : "",
    session.leadFacts.budget ? `Budget/prezzo: ${session.leadFacts.budget}` : "",
    session.leadFacts.appointment ? `Appuntamento: ${session.leadFacts.appointment}` : "",
    session.leadFacts.importRequest ? `Importazione: ${session.leadFacts.importRequest}` : "",
    "",
    "Per il contenuto preciso della conversazione usa la registrazione chiamata."
  ].filter((line) => line !== "").join("\n");
}

function hasOperationalLead(session) {
  return session.toolCalls.some((name) => [
    "avvisa_venditore",
    "registra_richiesta_importazione",
    "crea_appuntamento",
    "trasferisci_chiamata"
  ].includes(name));
}

async function sendFinalCallSummary(session) {
  if (session.summarySent) return;
  session.summarySent = true;
  saveLead({
    type: "call_summary",
    callSid: session.callSid,
    from: session.from,
    to: session.to,
    transcript: session.transcript,
    toolCalls: session.toolCalls
  });

  try {
    if (hasOperationalLead(session)) {
      logEvent("call_lead_whatsapp_skipped", {
        callSid: session.callSid,
        from: session.from,
        reason: "operational_lead_already_sent"
      });
    } else {
      const body = buildLeadWhatsapp(session);
      await notifySeller({ body });
      logEvent("call_lead_whatsapp_sent", {
        callSid: session.callSid,
        from: session.from
      });
    }
  } catch (error) {
    saveLead({
      type: "call_lead_whatsapp_failed",
      callSid: session.callSid,
      from: session.from,
      error: error.message
    });
    logEvent("call_lead_whatsapp_failed", {
      callSid: session.callSid,
      error: error.message
    });
  }

  try {
    const customerMessage = await sendCustomerAfterCallWhatsapp({ to: session.from });
    logEvent("call_customer_after_call_whatsapp_result", {
      callSid: session.callSid,
      from: session.from,
      skipped: Boolean(customerMessage.skipped),
      sid: customerMessage.sid || null
    });
  } catch (error) {
    saveLead({
      type: "customer_after_call_whatsapp_failed",
      callSid: session.callSid,
      from: session.from,
      error: error.message
    });
    logEvent("customer_after_call_whatsapp_failed", {
      callSid: session.callSid,
      from: session.from,
      error: error.message
    });
  }
}

async function handleRealtimeToolCall(event, openaiWs, session) {
  const { name, call_id: callId } = event.item;
  const args = safeJsonParse(event.item.arguments);

  try {
    logEvent("tool_call_started", { name, args });
    session?.toolCalls?.push(name);
    const output = await Promise.race([
      runTool(name, args, {
        callSid: session?.callSid,
        from: session?.from,
        to: session?.to
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Lo strumento sta impiegando troppo tempo.")), 2400);
      })
    ]);
    logEvent("tool_call_done", { name });
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output)
      }
    }));
  } catch (error) {
    logEvent("tool_call_failed", { name, error: error.message });
    alertSeller("tool_call_failed", {
      message: error.message,
      callSid: session?.callSid,
      from: session?.from,
      details: { tool: name, args }
    });
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ error: error.message })
      }
    }));
  }

  openaiWs.send(JSON.stringify({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: "Rispondi subito in modo naturale, con una frase breve. Se calendario o strumenti sono lenti, non restare in silenzio: raccogli nome, telefono e orario preferito, e di' che lo fai verificare in sede."
    }
  }));
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
        instructions: `Di esattamente: ${greetingForRome()}, Expocar Italia sono Marco. In cosa posso esserle utile?`
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
  let waitingForCustomer = false;
  let lastAssistantAudioAt = Date.now();
  let silenceTimer;
  const session = {
    startedAt: Date.now(),
    callSid: "",
    from: "",
    to: "",
    transcript: [],
    toolCalls: [],
    leadFacts: {},
    summarySent: false
  };

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`,
    {
      headers: openAIHeaders()
    }
  );

  function sendQuickAudio(instructions) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions
      }
    }));
  }

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const idleMs = Date.now() - lastAssistantAudioAt;
      const waitMs = waitingForCustomer ? 7000 : 2200;
      if (idleMs < waitMs || openaiWs.readyState !== WebSocket.OPEN || responseInProgress) {
        resetSilenceTimer();
        return;
      }
      logEvent("anti_silence_prompt", { callSid: session.callSid, idleMs });
      sendQuickAudio(waitingForCustomer
        ? "Il cliente e rimasto in silenzio. Di una frase naturale e breve, non robotica: E ancora in linea? oppure Mi sente?"
        : "Di una frase brevissima e naturale, variando le parole: Aspetti, guardo un attimo, oppure Le controllo subito.");
      lastAssistantAudioAt = Date.now();
      waitingForCustomer = true;
      resetSilenceTimer();
    }, 2200);
  }

  openaiWs.on("open", () => {
    logEvent("openai_realtime_open");
    resetSilenceTimer();
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
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "it",
              prompt: "Trascrivi solo parole realmente pronunciate in italiano. Ignora rumori di fondo, brusii, musica, voci lontane e parole non chiare. Non inventare frasi."
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.62,
              prefix_padding_ms: 250,
              silence_duration_ms: 550,
              interrupt_response: true
            }
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: config.openai.voice,
            speed: config.openai.speed
          }
        },
        tools: realtimeTools,
        tool_choice: "auto"
      }
    }));

    setTimeout(() => {
      if (openaiWs.readyState !== WebSocket.OPEN || session.transcript.length) return;
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: `Se non senti una voce automatica di portali come Subito, AutoScout24 o AutoSuperMarket, saluta in modo naturale, come una persona al telefono: ${greetingForRome()}, Expocar Italia sono Marco. Mi dica pure. Se invece senti o hai appena sentito un messaggio automatico del portale, resta in silenzio e aspetta il cliente reale.`
        }
      }));
    }, 1800);
  });

  twilioWs.on("message", (raw) => {
    const message = safeJsonParse(raw);

    if (message.event === "start") {
      streamSid = message.start?.streamSid;
      session.callSid = message.start?.callSid || message.start?.customParameters?.callSid || session.callSid;
      session.from = message.start?.customParameters?.from || session.from;
      session.to = message.start?.customParameters?.to || session.to;
      logEvent("twilio_media_start", {
        streamSid,
        callSid: session.callSid,
        from: session.from,
        to: session.to
      });
      return;
    }

    if (message.event === "media" && openaiWs.readyState === WebSocket.OPEN) {
      resetSilenceTimer();
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: message.media.payload
      }));
    }

    if (message.event === "stop") {
      logEvent("twilio_media_stop", { streamSid });
      sendFinalCallSummary(session);
      openaiWs.close();
    }
  });

  openaiWs.on("message", async (raw) => {
    const event = safeJsonParse(raw);

    if (event.type === "error") {
      logEvent("openai_realtime_server_error", {
        error: event.error
      });
      if (["response_cancel_not_active", "conversation_already_has_active_response"].includes(event.error?.code)) {
        responseInProgress = false;
        return;
      }
      alertSeller("openai_realtime_server_error", {
        message: event.error?.message,
        code: event.error?.code,
        callSid: session.callSid,
        from: session.from,
        details: event.error
      });
      return;
    }

    if (event.type === "session.created" || event.type === "session.updated" || event.type === "response.created") {
      logEvent("openai_realtime_event", { eventType: event.type });
    }

    if (event.type === "response.created") {
      responseInProgress = true;
      waitingForCustomer = false;
      resetSilenceTimer();
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed"
      || event.type === "input_audio_buffer.transcription.completed"
    ) {
      appendTranscript(session, "Cliente", extractTranscript(event));
      return;
    }

    if (
      event.type === "response.audio_transcript.done"
      || event.type === "response.output_audio_transcript.done"
      || event.type === "response.output_item.done"
    ) {
      const transcript = extractTranscript(event);
      if (transcript) appendTranscript(session, "Marco", transcript);
    }

    if (event.type === "input_audio_buffer.speech_started") {
      logEvent("openai_speech_started", { responseInProgress });
      waitingForCustomer = false;
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
      lastAssistantAudioAt = Date.now();
      resetSilenceTimer();
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
      waitingForCustomer = true;
      resetSilenceTimer();
      logEvent("openai_response_done", {
        status: event.response?.status,
        statusDetails: event.response?.status_details,
        outputTypes: event.response?.output?.map((item) => item.type)
      });
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await handleRealtimeToolCall(event, openaiWs, session);
    }
  });

  openaiWs.on("error", (error) => {
    logEvent("openai_realtime_error", {
      message: error.message,
      code: error.code
    });
    alertSeller("openai_realtime_error", {
      message: error.message,
      code: error.code,
      callSid: session.callSid,
      from: session.from
    });
  });

  twilioWs.on("error", (error) => {
    logEvent("twilio_media_error", {
      message: error.message,
      code: error.code
    });
    alertSeller("twilio_media_error", {
      message: error.message,
      code: error.code,
      callSid: session.callSid,
      from: session.from
    });
  });

  twilioWs.on("close", () => {
    clearTimeout(silenceTimer);
    sendFinalCallSummary(session);
    openaiWs.close();
  });
  openaiWs.on("close", () => {
    clearTimeout(silenceTimer);
    twilioWs.close();
  });
}
