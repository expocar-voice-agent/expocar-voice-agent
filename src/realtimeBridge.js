import WebSocket from "ws";
import { config } from "./config.js";
import { agentInstructions } from "./agentPrompt.js";
import { logEvent } from "./logger.js";
import { realtimeTools, runTool } from "./tools.js";
import { saveLead } from "./leads.js";
import { notifySeller } from "./whatsapp.js";
import { alertSeller } from "./alerts.js";
import { elevenLabsConfigured, streamElevenLabsUlaw } from "./elevenlabs.js";

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

function setLeadFact(session, key, value) {
  const clean = clipText(value, 260);
  if (clean) session.leadFacts[key] = clean;
}

function extractEmail(text) {
  return String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function extractName(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const match = clean.match(/\b(?:mi chiamo|sono|nome\s+e|il nome e|nome)\s+([a-z']{3,}(?:\s+[a-z']{3,})?)/i);
  if (!match) return "";
  const name = match[1].trim();
  return /giusy|marco|expocar|buongiorno|pomeriggio|buonasera/i.test(name) ? "" : name;
}

function updateLeadFacts(session, speaker, text) {
  if (speaker !== "Cliente") return;
  const clean = clipText(text, 220);
  if (!clean || clean.length < 4) return;

  const normalized = normalizeLeadText(clean);
  const looksForeign = /\b(thank you|please|hello|good morning|how can i help|appointment request|customer asked)\b/i.test(clean)
    && !/\b(appuntamento|auto|macchina|prezzo|budget|domani|oggi|telefono|nome|email|consulente)\b/.test(normalized);
  if (looksForeign) return;

  const mentionsAppointment = /\b(appuntamento|domani|oggi|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|alle\s+\d{1,2}|consulente)\b/.test(normalized);
  const mentionsImport = /\b(import|estero|germania|europa|ordinare|cercare|ricerca|su misura)\b/.test(normalized);
  const mentionsBudget = /\b(budget|euro|prezzo|finanziamento|leasing|permuta|sconto)\b/.test(normalized) || /\d{2,3}\.?\d{3}/.test(normalized);
  const mentionsVehicle = /\b(auto|macchina|vettura|audi|bmw|mercedes|porsche|range|smart|x5|q3|benzina|diesel|ibrida|elettrica|suv)\b/.test(normalized);
  const mentionsSeaNext = /\b(sea\s*next|seanxt|scooter|subacque)\b/.test(normalized);
  const email = extractEmail(clean);
  const name = extractName(clean);

  if (email) setLeadFact(session, "email", email);
  if (name) setLeadFact(session, "name", name);
  if (mentionsAppointment) setLeadFact(session, "appointment", clean);
  if (mentionsImport) setLeadFact(session, "importRequest", clean);
  if (mentionsBudget) setLeadFact(session, "budget", clean);
  if (mentionsVehicle || mentionsSeaNext) setLeadFact(session, "interest", clean);
  if (!session.leadFacts.request && (mentionsAppointment || mentionsImport || mentionsBudget || mentionsVehicle || mentionsSeaNext)) {
    setLeadFact(session, "request", clean);
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

function formatRomeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function customerTranscriptPieces(session, limit = 4) {
  return session.transcript
    .filter((piece) => piece.speaker === "Cliente")
    .map((piece) => clipText(piece.text, 180))
    .filter(Boolean)
    .filter((text, index, list) => list.indexOf(text) === index)
    .slice(-limit);
}

function buildLeadSummary(session) {
  const facts = session.leadFacts;
  if (facts.appointmentConfirmed) {
    return `Appuntamento fissato: ${facts.appointmentConfirmed}${facts.interest ? ` per ${facts.interest}` : ""}.`;
  }
  if (facts.transfer) {
    return `Il cliente ha chiesto contatto diretto o consulente. ${facts.transfer}`;
  }
  if (facts.importRequest) {
    return `Richiesta importazione/ricerca su misura: ${facts.importRequest}`;
  }
  if (facts.request) return facts.request;
  if (facts.interest) return `Cliente interessato a ${facts.interest}.`;
  return "Richiesta da completare: consultare registrazione chiamata.";
}

function buildLeadWhatsapp(session) {
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  const facts = session.leadFacts;
  const customerPieces = customerTranscriptPieces(session);

  return [
    "Lead ExpoCar",
    `Telefono cliente: ${facts.phone || session.from || "numero non disponibile"}`,
    facts.name ? `Nome: ${facts.name}` : "",
    facts.email ? `Email: ${facts.email}` : "",
    session.callSid ? `Call SID: ${session.callSid}` : "",
    `Durata circa: ${durationSeconds} sec`,
    "",
    `Sintesi: ${buildLeadSummary(session)}`,
    facts.interest ? `Interesse/auto: ${facts.interest}` : "",
    facts.budget ? `Budget/prezzo: ${facts.budget}` : "",
    facts.appointmentConfirmed ? `Appuntamento confermato: ${facts.appointmentConfirmed}` : facts.appointment ? `Appuntamento richiesto: ${facts.appointment}` : "",
    facts.importRequest ? `Importazione: ${facts.importRequest}` : "",
    facts.transfer ? `Trasferimento/contatto diretto: ${facts.transfer}` : "",
    facts.notes ? `Note: ${facts.notes}` : "",
    customerPieces.length ? "" : "",
    customerPieces.length ? `Elementi detti dal cliente: ${customerPieces.join(" | ")}` : "",
    "",
    "Per il contenuto preciso della conversazione usa la registrazione chiamata."
  ].filter((line) => line !== "").join("\n");
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
    const body = buildLeadWhatsapp(session);
    await notifySeller({ body });
    logEvent("call_lead_whatsapp_sent", {
      callSid: session.callSid,
      from: session.from
    });
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
  logEvent("customer_after_call_whatsapp_disabled", {
    callSid: session.callSid,
    from: session.from,
    reason: "customer_messages_managed_by_simplybook"
  });
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
    if (session) {
      if (args.name) setLeadFact(session, "name", args.name);
      if (args.phone) setLeadFact(session, "phone", args.phone);
      if (args.email) setLeadFact(session, "email", args.email);
      if (args.interest) setLeadFact(session, "interest", args.interest);
      if (args.notes) setLeadFact(session, "notes", args.notes);

      if (name === "crea_appuntamento") {
        const appointmentLabel = output?.appointment?.start ? formatRomeDate(output.appointment.start) : "";
        setLeadFact(session, "appointment", [
          args.localDate || args.startTime || "",
          args.localTime || "",
          args.interest ? `per ${args.interest}` : ""
        ].filter(Boolean).join(" "));
        if (appointmentLabel) setLeadFact(session, "appointmentConfirmed", appointmentLabel);
        if (output?.pendingConfirmation) setLeadFact(session, "notes", "Appuntamento da confermare manualmente.");
      }

      if (name === "registra_richiesta_importazione") {
        setLeadFact(session, "importRequest", args.summary || args.request);
        const car = [args.brand, args.model].filter(Boolean).join(" ");
        if (car) setLeadFact(session, "interest", car);
        if (args.budget) setLeadFact(session, "budget", args.budget);
      }

      if (name === "avvisa_venditore") {
        setLeadFact(session, "request", args.summary);
      }

      if (name === "trasferisci_chiamata") {
        setLeadFact(session, "transfer", args.reason || "Trasferimento richiesto dal cliente.");
      }
    }
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
      output_modalities: [elevenLabsConfigured() ? "text" : "audio"],
      instructions: "Rispondi subito in modo naturale, con una frase breve. Se il sistema prenotazioni o gli strumenti sono lenti, non restare in silenzio: raccogli nome, telefono e orario preferito, e di' che lo fai verificare in sede."
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
        instructions: `Di esattamente: ${greetingForRome()}, Expocar Italia sono Giusy. In cosa posso esserle utile?`
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
  let initialGreetingInProgress = false;
  let initialGreetingDone = false;
  let initialGreetingRepeated = false;
  let initialGreetingTimer;
  let initialGreetingBlockedUntil = 0;
  let initialCustomerAudioHeard = false;
  let assistantTextBuffer = "";
  const useElevenLabs = elevenLabsConfigured();
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
        output_modalities: [useElevenLabs ? "text" : "audio"],
        instructions
      }
    }));
  }

  async function sendElevenLabsAudio(text) {
    if (!useElevenLabs || !streamSid || !text.trim()) return false;
    try {
      const result = await streamElevenLabsUlaw(text, async (audio) => {
        if (twilioWs.readyState !== WebSocket.OPEN) return;
        lastAssistantAudioAt = Date.now();
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audio.toString("base64") }
        }));
      });
      if (result.skipped) return false;
      return true;
    } catch (error) {
      logEvent("elevenlabs_tts_failed", {
        callSid: session.callSid,
        from: session.from,
        message: error.message
      });
      alertSeller("elevenlabs_tts_failed", {
        message: error.message,
        callSid: session.callSid,
        from: session.from
      });
      return false;
    }
  }

  function initialGreetingText() {
    return `${greetingForRome()}, Expocar Italia sono Giusy. In cosa posso esserle utile?`;
  }

  function customerHasSpoken() {
    return initialCustomerAudioHeard || session.transcript.some((piece) => piece.speaker === "Cliente");
  }

  function sendInitialGreeting({ repeat = false } = {}) {
    if (openaiWs.readyState !== WebSocket.OPEN || responseInProgress) return;
    if (!repeat && Date.now() < initialGreetingBlockedUntil) {
      scheduleInitialGreeting(initialGreetingBlockedUntil - Date.now() + 350);
      return;
    }
    initialGreetingInProgress = true;
    if (repeat) initialGreetingRepeated = true;
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: [useElevenLabs ? "text" : "audio"],
        instructions: `Di esattamente, senza aggiungere altro e senza fermarti: ${initialGreetingText()}`
      }
    }));
  }

  function scheduleInitialGreeting(delayMs = 900) {
    clearTimeout(initialGreetingTimer);
    if (initialGreetingDone || customerHasSpoken()) return;
    initialGreetingTimer = setTimeout(() => {
      if (openaiWs.readyState !== WebSocket.OPEN || initialGreetingDone || responseInProgress || customerHasSpoken()) return;
      sendInitialGreeting();
    }, delayMs);
  }

  function scheduleInitialGreetingRepeat() {
    clearTimeout(initialGreetingTimer);
    if (!initialGreetingDone || initialGreetingRepeated || customerHasSpoken()) return;
    initialGreetingTimer = setTimeout(() => {
      if (customerHasSpoken() || responseInProgress || openaiWs.readyState !== WebSocket.OPEN) return;
      logEvent("initial_greeting_repeated", { callSid: session.callSid });
      sendInitialGreeting({ repeat: true });
    }, 5000);
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
        output_modalities: [useElevenLabs ? "text" : "audio"],
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
              threshold: 0.6,
              prefix_padding_ms: 220,
              silence_duration_ms: 430,
              interrupt_response: true
            }
          },
          ...(useElevenLabs ? {} : {
            output: {
              format: { type: "audio/pcmu" },
              voice: config.openai.voice,
              speed: config.openai.speed
            }
          })
        },
        tools: realtimeTools,
        tool_choice: "auto"
      }
    }));

    scheduleInitialGreeting(900);
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
      assistantTextBuffer = "";
      resetSilenceTimer();
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed"
      || event.type === "input_audio_buffer.transcription.completed"
    ) {
      appendTranscript(session, "Cliente", extractTranscript(event));
      clearTimeout(initialGreetingTimer);
      return;
    }

    if (
      event.type === "response.audio_transcript.done"
      || event.type === "response.output_audio_transcript.done"
      || event.type === "response.output_item.done"
    ) {
      const transcript = extractTranscript(event);
      if (transcript) {
        if (useElevenLabs) {
          assistantTextBuffer = assistantTextBuffer || transcript;
        } else {
          appendTranscript(session, "Giusy", transcript);
        }
      }
    }

    if (event.type === "response.output_text.delta" || event.type === "response.text.delta") {
      assistantTextBuffer += event.delta || "";
      return;
    }

    if (event.type === "response.output_text.done" || event.type === "response.text.done") {
      assistantTextBuffer = event.text || assistantTextBuffer;
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      logEvent("openai_speech_started", { responseInProgress });
      waitingForCustomer = false;
      initialCustomerAudioHeard = true;
      if (initialGreetingDone) {
        clearTimeout(initialGreetingTimer);
      }
      if (!initialGreetingDone && !initialGreetingInProgress) {
        initialCustomerAudioHeard = false;
        initialGreetingBlockedUntil = Date.now() + 1300;
        scheduleInitialGreeting(1650);
        logEvent("initial_greeting_delayed_for_inbound_audio", { callSid: session.callSid });
        return;
      }
      if (initialGreetingInProgress) {
        clearTimeout(initialGreetingTimer);
        logEvent("initial_greeting_interrupt_ignored", { callSid: session.callSid });
        return;
      }
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

    if (event.type === "input_audio_buffer.speech_stopped" && !initialGreetingDone && !initialGreetingInProgress) {
      initialGreetingBlockedUntil = Date.now() + 450;
      scheduleInitialGreeting(700);
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
      if (useElevenLabs && !assistantTextBuffer.trim()) {
        assistantTextBuffer = extractTranscript(event);
      }
      if (useElevenLabs && assistantTextBuffer.trim()) {
        const spokenText = assistantTextBuffer.trim();
        appendTranscript(session, "Giusy", spokenText);
        await sendElevenLabsAudio(spokenText);
      }
      responseInProgress = false;
      if (initialGreetingInProgress) {
        initialGreetingInProgress = false;
        initialGreetingDone = true;
        scheduleInitialGreetingRepeat();
      }
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
    clearTimeout(initialGreetingTimer);
    sendFinalCallSummary(session);
    openaiWs.close();
  });
  openaiWs.on("close", () => {
    clearTimeout(silenceTimer);
    clearTimeout(initialGreetingTimer);
    twilioWs.close();
  });
}

