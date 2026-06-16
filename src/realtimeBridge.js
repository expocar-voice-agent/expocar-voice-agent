import WebSocket from "ws";
import { config } from "./config.js";
import { agentInstructions } from "./agentPrompt.js";
import { logEvent } from "./logger.js";
import { realtimeTools, runTool, transferActiveCall } from "./tools.js";
import { saveLead } from "./leads.js";
import { alertSeller } from "./alerts.js";
import { elevenLabsConfigured, streamElevenLabsUlaw } from "./elevenlabs.js";
import { submitCallSummary } from "./callNotifications.js";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return /giusy|martina|marco|expocar|buongiorno|pomeriggio|buonasera/i.test(name) ? "" : name;
}

function normalizeCallerPhone(value) {
  let phone = String(value || "").trim().replace(/^whatsapp:/i, "").replace(/[^\d+]/g, "");
  if (!phone) return "";
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (phone.startsWith("+39")) return phone;
  if (phone.startsWith("39") && phone.length >= 12) return `+${phone}`;
  const digits = phone.replace(/\D/g, "");
  if (/^3\d{8,10}$/.test(digits) || /^0\d{6,11}$/.test(digits)) return `+39${digits}`;
  return phone.startsWith("+") ? phone : digits ? `+${digits}` : "";
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
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  if (Number.isNaN(hour)) return "Buongiorno";
  if (hour < 13) return "Buongiorno";
  if (hour < 18) return "Buon pomeriggio";
  return "Buonasera";
}

function greetingForSentence() {
  return greetingForRome().toLowerCase();
}

function decodeMuLawSample(byte) {
  const value = ~byte & 0xff;
  const sign = value & 0x80 ? -1 : 1;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  return sign * ((((mantissa << 3) + 0x84) << exponent) - 0x84);
}

function payloadHasVoice(payload) {
  return payloadVoiceEnergy(payload) > 900;
}

function payloadVoiceEnergy(payload) {
  if (!payload) return 0;
  const audio = Buffer.from(payload, "base64");
  if (audio.length < 80) return 0;

  let sum = 0;
  const step = Math.max(1, Math.floor(audio.length / 80));
  let count = 0;
  for (let index = 0; index < audio.length; index += step) {
    sum += Math.abs(decodeMuLawSample(audio[index]));
    count += 1;
  }

  return count > 0 ? sum / count : 0;
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

function formatRomeCallDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "", time: "" };
  const dateText = new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
  const timeText = new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
  return { date: dateText, time: timeText };
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return `${rest} secondi`;
  if (!rest) return `${minutes} ${minutes === 1 ? "minuto" : "minuti"}`;
  return `${minutes} ${minutes === 1 ? "minuto" : "minuti"} ${rest} secondi`;
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

function transcriptForSummary(session) {
  return session.transcript
    .map((piece) => `${piece.speaker}: ${piece.text}`)
    .join("\n")
    .slice(-8000);
}

async function buildAiCallSummary(session) {
  const transcript = transcriptForSummary(session);
  if (!transcript.trim()) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openai.summaryModel,
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content: "Riassumi una telefonata commerciale ExpoCar in italiano. Sii concreto, professionale e breve. Non inventare dati. Evidenzia auto richiesta, richieste specifiche, problemi di comunicazione, appuntamenti, trasferimenti, finanziamenti, promesse di verifica o ricontatto."
          },
          {
            role: "user",
            content: [
              `Telefono cliente: ${session.leadFacts.phone || normalizeCallerPhone(session.from) || session.from || "non disponibile"}`,
              session.leadFacts.interest ? `Interesse noto: ${session.leadFacts.interest}` : "",
              session.leadFacts.appointmentConfirmed ? `Appuntamento confermato: ${session.leadFacts.appointmentConfirmed}` : "",
              session.leadFacts.transfer ? `Trasferimento: ${session.leadFacts.transfer}` : "",
              "",
              "Trascrizione:",
              transcript
            ].filter(Boolean).join("\n")
          }
        ]
      })
    });
    if (!response.ok) return "";
    const data = await response.json();
    return clipText(data.choices?.[0]?.message?.content || "", 900);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function buildLeadWhatsapp(session) {
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  const facts = session.leadFacts;
  const customerPieces = customerTranscriptPieces(session);
  const aiSummary = await buildAiCallSummary(session);
  const callDate = formatRomeCallDate(session.startedAt);

  return [
    "Lead ExpoCar",
    "",
    "Riassunto della chiamata",
    aiSummary || buildLeadSummary(session),
    "",
    "Dettagli chiamata",
    callDate.date || "",
    callDate.time ? `Alle ${callDate.time}` : "",
    session.callSid ? `Call SID: ${session.callSid}` : "",
    `Durata: ${formatDuration(durationSeconds)}`,
    "",
    "Dettagli cliente",
    facts.phone || normalizeCallerPhone(session.from) || session.from || "numero non disponibile",
    facts.name ? `Nome: ${facts.name}` : "",
    facts.email ? `Email: ${facts.email}` : "",
    "",
    "Dati utili",
    facts.interest ? `Interesse/auto: ${facts.interest}` : "",
    facts.budget ? `Budget/prezzo: ${facts.budget}` : "",
    facts.appointmentConfirmed ? `Appuntamento confermato: ${facts.appointmentConfirmed}` : facts.appointment ? `Appuntamento richiesto: ${facts.appointment}` : "",
    facts.importRequest ? `Importazione: ${facts.importRequest}` : "",
    facts.transfer ? `Trasferimento/contatto diretto: ${facts.transfer}` : "",
    facts.notes ? `Note: ${facts.notes}` : "",
    customerPieces.length ? "" : "",
    customerPieces.length ? `Elementi detti dal cliente: ${customerPieces.join(" | ")}` : "",
    "Registrazione: usare il link ricevuto nel messaggio separato, se disponibile."
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
    const body = await buildLeadWhatsapp(session);
    await submitCallSummary({ callSid: session.callSid, body });
    logEvent("call_lead_summary_queued", {
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

function inferConversationLanguage(session) {
  const recentCustomerText = session.transcript
    .filter((piece) => piece.speaker === "Cliente")
    .slice(-5)
    .map((piece) => piece.text)
    .join(" ")
    .toLowerCase();
  if (!recentCustomerText.trim()) return "it";

  const englishMatches = recentCustomerText.match(/\b(hello|hi|please|english|speak|appointment|available|price|car|consultant|sales|thank you|yes|no|looking|interested|can you|do you|have you)\b/g)?.length || 0;
  const italianMatches = recentCustomerText.match(/\b(buongiorno|salve|italiano|appuntamento|disponibile|prezzo|auto|macchina|consulente|venditore|grazie|si|vorrei|avete|posso|parlare)\b/g)?.length || 0;
  return englishMatches > italianMatches + 1 ? "en" : "it";
}

function estimateSpeechMs(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return 0;
  const words = clean.split(" ").length;
  return Math.max(1800, Math.ceil((words / 2.4) * 1000));
}

function currentRomeInstruction() {
  const now = new Date();
  const label = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(now);
  return [
    `Oggi in Italia e ${label}.`,
    "Quando il cliente dice un giorno relativo, per esempio lunedi alle 11, interpreta sempre il primo giorno utile futuro in Italia e non chiedere di specificare la data."
  ].join(" ");
}

async function handleRealtimeToolCall(event, openaiWs, session, options = {}) {
  const { name, call_id: callId } = event.item;
  const parsedArgs = safeJsonParse(event.item.arguments);
  const args = name === "trasferisci_chiamata" && !parsedArgs.language
    ? { ...parsedArgs, language: inferConversationLanguage(session) }
    : parsedArgs;
  const timeoutMs = name === "cerca_auto"
    ? 3800
    : name === "controlla_disponibilita" || name === "crea_appuntamento"
      ? 6000
      : 3500;
  let slowToolTimer;

  try {
    logEvent("tool_call_started", { name, args });
    session?.toolCalls?.push(name);
    if (["cerca_auto", "controlla_disponibilita", "crea_appuntamento"].includes(name) && typeof options.onSlowTool === "function") {
      const slowToolDelayMs = name === "cerca_auto"
        ? 2200
        : name === "crea_appuntamento"
          ? 1100
          : 1500;
      slowToolTimer = setTimeout(() => {
        Promise.resolve(options.onSlowTool(name, args)).catch((error) => {
          logEvent("tool_call_bridge_audio_failed", { name, error: error.message });
        });
      }, slowToolDelayMs);
    }
    const output = await Promise.race([
      runTool(name, args, {
        callSid: session?.callSid,
        from: session?.from,
        to: session?.to
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Operazione non completata nei tempi previsti.")), timeoutMs);
      })
    ]);
    clearTimeout(slowToolTimer);
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
        if (output?.transferAfterResponse) {
          session.transferAfterResponse = {
            reason: args.reason || "Trasferimento richiesto dal cliente.",
            spokenReply: output.spokenReply || "",
            language: output.language || args.language || inferConversationLanguage(session)
          };
        }
      }

      if (name === "chiudi_chiamata") {
        session.closeAfterResponse = true;
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
    clearTimeout(slowToolTimer);
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
        output: JSON.stringify({
          error: error.message,
          spokenReply: name === "cerca_auto"
            ? "Mi lasci verificare meglio questa disponibilita in sede, cosi non le do un'informazione imprecisa. Intanto mi conferma modello e budget?"
            : "Mi lasci prendere nota della richiesta, cosi la faccio verificare in sede senza darle un'informazione imprecisa."
        })
      }
    }));
  }

  const followUpInstructions = "Rispondi subito nella lingua della conversazione: italiano se il cliente parla italiano, inglese semplice se il cliente non parla italiano. Se il risultato dello strumento contiene spokenReply, usala come base principale e non leggere campi tecnici, JSON, id, slot, date ISO o nomi di sistemi. Non usare spagnolo, francese o altre lingue. Non dire mai che il sistema e lento o che c'e un problema tecnico: se manca un dato, chiedi una conferma o di' che lo fai verificare in sede.";
  if (typeof options.requestToolResponse === "function") {
    options.requestToolResponse(followUpInstructions, { toolName: name });
  } else {
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: [elevenLabsConfigured() ? "text" : "audio"],
        instructions: followUpInstructions
      }
    }));
  }
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
        instructions: "Di esattamente: Expocar Italia, sono Martina."
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
  let responseStartedAt = 0;
  let lastStuckResponseRecoveryAt = 0;
  let waitingForCustomer = false;
  let lastAssistantAudioAt = Date.now();
  let silenceTimer;
  let bargeInTimer;
  let customerSpeechActive = false;
  let assistantAudioQueuedUntil = 0;
  let ttsPlaybackGeneration = 0;
  let assistantTtsInterrupted = false;
  let initialGreetingInProgress = false;
  let initialGreetingDone = false;
  let initialGreetingRepeated = false;
  let initialGreetingTimer;
  let initialGreetingBlockedUntil = 0;
  let initialCustomerAudioHeard = false;
  let initialGreetingCompletedAt = 0;
  let lastInitialInboundVoiceAt = 0;
  let initialAudioWaitLogged = false;
  let initialInboundVoiceFrames = 0;
  let assistantTextBuffer = "";
  let assistantTtsRemainder = "";
  let assistantTtsQueue = Promise.resolve();
  let pendingToolResponseInstructions = "";
  let pendingToolResponseAt = 0;
  const useElevenLabs = elevenLabsConfigured();
  const session = {
    startedAt: Date.now(),
    callSid: "",
    from: "",
    to: "",
    transcript: [],
    toolCalls: [],
    leadFacts: {},
    closeAfterResponse: false,
    transferAfterResponse: null,
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

  function requestModelResponse(instructions, meta = {}) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    const clean = String(instructions || "").trim();
    if (!clean) return;

    if (responseInProgress) {
      pendingToolResponseInstructions = clean;
      pendingToolResponseAt = Date.now();
      logEvent("model_response_deferred", {
        callSid: session.callSid,
        reason: meta.reason || "response_in_progress",
        toolName: meta.toolName || ""
      });
      resetSilenceTimer();
      return;
    }

    pendingToolResponseInstructions = "";
    pendingToolResponseAt = 0;
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: [useElevenLabs ? "text" : "audio"],
        instructions: clean
      }
    }));
  }

  function flushPendingToolResponse(reason = "response_done") {
    if (!pendingToolResponseInstructions || responseInProgress) return;
    const instructions = pendingToolResponseInstructions;
    pendingToolResponseInstructions = "";
    pendingToolResponseAt = 0;
    logEvent("model_response_deferred_flush", {
      callSid: session.callSid,
      reason
    });
    requestModelResponse(instructions, { reason });
  }

  async function sendElevenLabsAudio(text) {
    if (!useElevenLabs || !streamSid || !text.trim()) return false;
    if (assistantTtsInterrupted) return false;
    const playbackGeneration = ++ttsPlaybackGeneration;
    try {
      const result = await streamElevenLabsUlaw(text, async (audio) => {
        const frameBytes = Math.max(80, config.elevenlabs.frameBytes || 160);
        const frameDelayMs = Math.max(0, config.elevenlabs.frameDelayMs || 0);
        for (let offset = 0; offset < audio.length; offset += frameBytes) {
          if (twilioWs.readyState !== WebSocket.OPEN) return;
          if (assistantTtsInterrupted || playbackGeneration !== ttsPlaybackGeneration) return;
          const frame = audio.subarray(offset, offset + frameBytes);
          lastAssistantAudioAt = Date.now();
          assistantAudioQueuedUntil = Math.max(assistantAudioQueuedUntil, Date.now()) + Math.ceil(frame.length / 8);
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: frame.toString("base64") }
          }));
          if (frameDelayMs) await sleep(frameDelayMs);
        }
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

  function queueElevenLabsAudio(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!useElevenLabs || !clean || assistantTtsInterrupted) return assistantTtsQueue;
    assistantTtsQueue = assistantTtsQueue.then(() => sendElevenLabsAudio(clean));
    return assistantTtsQueue;
  }

  function queueSpeakableText({ flush = false } = {}) {
    if (!useElevenLabs || assistantTtsInterrupted) return;
    let text = assistantTtsRemainder.replace(/\s+/g, " ").trim();
    if (!text) return;

    let chunk = "";
    const sentence = text.match(/^(.{28,240}?[.!?])\s+/);
    if (sentence) {
      chunk = sentence[1].trim();
    } else if (flush) {
      chunk = text;
    }

    if (!chunk) return;
    assistantTtsRemainder = text.slice(chunk.length).trim();
    queueElevenLabsAudio(chunk);
  }

  function resetAssistantResponseAudio() {
    assistantTextBuffer = "";
    assistantTtsRemainder = "";
    assistantTtsQueue = Promise.resolve();
    assistantTtsInterrupted = false;
  }

  function initialGreetingText() {
    return "Expocar Italia, sono Martina.";
  }

  function customerHasSpoken() {
    return initialCustomerAudioHeard || session.transcript.some((piece) => piece.speaker === "Cliente");
  }

  function sendInitialGreeting({ repeat = false } = {}) {
    if (openaiWs.readyState !== WebSocket.OPEN || responseInProgress) return;
    if (!repeat && !initialGreetingDone && lastInitialInboundVoiceAt && Date.now() - lastInitialInboundVoiceAt < 1800) {
      scheduleInitialGreeting(1900);
      return;
    }
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
    return;
  }

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const idleMs = Date.now() - lastAssistantAudioAt;
      const waitingAfterInitialGreeting = initialGreetingDone
        && !initialCustomerAudioHeard
        && !session.transcript.some((piece) => piece.speaker === "Cliente");
      const waitMs = waitingAfterInitialGreeting ? 12000 : waitingForCustomer ? 6500 : 2200;

      if (openaiWs.readyState !== WebSocket.OPEN) {
        resetSilenceTimer();
        return;
      }

      if (responseInProgress) {
        const responseAgeMs = Date.now() - responseStartedAt;
        const recoveryCooldownMs = Date.now() - lastStuckResponseRecoveryAt;
        const pendingToolAgeMs = pendingToolResponseAt ? Date.now() - pendingToolResponseAt : 0;
        if (pendingToolResponseInstructions && responseAgeMs > 4200 && pendingToolAgeMs > 1800 && idleMs > 3200 && recoveryCooldownMs > 6500) {
          const instructions = pendingToolResponseInstructions;
          pendingToolResponseInstructions = "";
          pendingToolResponseAt = 0;
          lastStuckResponseRecoveryAt = Date.now();
          logEvent("pending_tool_response_recovery", {
            callSid: session.callSid,
            responseAgeMs,
            pendingToolAgeMs,
            idleMs
          });
          try {
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          } catch {}
          responseInProgress = false;
          responseStartedAt = 0;
          setTimeout(() => {
            requestModelResponse(instructions, { reason: "pending_tool_response_recovery" });
          }, 250);
          resetSilenceTimer();
          return;
        }
        if (responseAgeMs > 7000 && idleMs > 5500 && recoveryCooldownMs > 9000) {
          lastStuckResponseRecoveryAt = Date.now();
          logEvent("stuck_response_recovery", {
            callSid: session.callSid,
            responseAgeMs,
            idleMs
          });
          try {
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          } catch {}
          responseInProgress = false;
          responseStartedAt = 0;
          waitingForCustomer = true;
          setTimeout(() => {
            if (openaiWs.readyState !== WebSocket.OPEN) return;
            sendQuickAudio("Di una sola frase naturale e breve: Mi scusi, ci sono. Mi ripete l'ultima richiesta?");
            lastAssistantAudioAt = Date.now();
          }, 300);
        }
        resetSilenceTimer();
        return;
      }

      if (idleMs < waitMs) {
        resetSilenceTimer();
        return;
      }
      logEvent("anti_silence_prompt", { callSid: session.callSid, idleMs });
      sendQuickAudio(waitingAfterInitialGreeting
        ? "Di esattamente, senza aggiungere altro: Expocar Italia, sono Martina."
        : waitingForCustomer
        ? "Di una sola frase molto naturale, come in una telefonata reale: Mi sente? oppure E ancora in linea?"
        : "Di una sola frase brevissima e naturale, senza ripeterla due volte: Sì, guardo subito. oppure Un attimo che controllo.");
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
        instructions: `${agentInstructions}\n\n${currentRomeInstruction()}`,
        output_modalities: [useElevenLabs ? "text" : "audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: "gpt-4o-mini-transcribe",
              prompt: "Trascrivi solo parole realmente pronunciate in italiano o inglese. Ignora rumori di fondo, brusii, musica, voci lontane, micro-assensi e parole non chiare. Non inventare frasi."
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 220,
              silence_duration_ms: 360,
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

    scheduleInitialGreeting(1400);
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
      if (!initialGreetingDone && !initialGreetingInProgress) {
        const initialVoiceEnergy = payloadVoiceEnergy(message.media?.payload);
        if (initialVoiceEnergy > 1500) {
          initialInboundVoiceFrames += 1;
        } else {
          initialInboundVoiceFrames = Math.max(0, initialInboundVoiceFrames - 1);
        }

        if (initialInboundVoiceFrames >= 10) {
          lastInitialInboundVoiceAt = Date.now();
          initialGreetingBlockedUntil = Date.now() + 1900;
          scheduleInitialGreeting(2100);
          if (!initialAudioWaitLogged) {
            initialAudioWaitLogged = true;
            logEvent("initial_greeting_waiting_for_initial_clear_voice", {
              callSid: session.callSid,
              energy: Math.round(initialVoiceEnergy)
            });
          }
        }
      }
      if (
        initialGreetingDone
        && !initialGreetingRepeated
        && !initialCustomerAudioHeard
        && Date.now() - initialGreetingCompletedAt < 7000
        && payloadHasVoice(message.media?.payload)
      ) {
        initialCustomerAudioHeard = true;
        clearTimeout(initialGreetingTimer);
        logEvent("initial_greeting_repeat_cancelled_by_audio", { callSid: session.callSid });
      }
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
        responseStartedAt = 0;
        flushPendingToolResponse(`server_error_${event.error?.code}`);
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
      responseStartedAt = Date.now();
      waitingForCustomer = false;
      resetAssistantResponseAudio();
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
          if (!assistantTtsRemainder.trim()) assistantTtsRemainder = transcript;
        } else {
          appendTranscript(session, "Martina", transcript);
        }
      }
    }

    if (event.type === "response.output_text.delta" || event.type === "response.text.delta") {
      const delta = event.delta || "";
      assistantTextBuffer += delta;
      assistantTtsRemainder += delta;
      queueSpeakableText();
      return;
    }

    if (event.type === "response.output_text.done" || event.type === "response.text.done") {
      if (event.text && !assistantTextBuffer.trim()) {
        assistantTextBuffer = event.text;
        assistantTtsRemainder = event.text;
        queueSpeakableText();
      }
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      logEvent("openai_speech_started", { responseInProgress });
      waitingForCustomer = false;
      customerSpeechActive = true;
      if (initialGreetingDone) {
        initialCustomerAudioHeard = true;
        clearTimeout(initialGreetingTimer);
      }
      if (!initialGreetingDone && !initialGreetingInProgress) {
        if (initialInboundVoiceFrames >= 6) {
          initialCustomerAudioHeard = false;
          lastInitialInboundVoiceAt = Date.now();
          initialGreetingBlockedUntil = Date.now() + 1900;
          scheduleInitialGreeting(2100);
          logEvent("initial_greeting_delayed_for_inbound_audio", { callSid: session.callSid });
          return;
        }
        logEvent("initial_greeting_ignored_weak_initial_audio", { callSid: session.callSid });
      } else {
        initialCustomerAudioHeard = true;
      }
      if (initialGreetingInProgress) {
        clearTimeout(initialGreetingTimer);
        logEvent("initial_greeting_interrupt_ignored", { callSid: session.callSid });
        return;
      }
      if ((responseInProgress || Date.now() < assistantAudioQueuedUntil + 350) && openaiWs.readyState === WebSocket.OPEN) {
        clearTimeout(bargeInTimer);
        bargeInTimer = setTimeout(() => {
          if (!customerSpeechActive || openaiWs.readyState !== WebSocket.OPEN) return;
          if (!responseInProgress && Date.now() >= assistantAudioQueuedUntil + 350) return;
          logEvent("barge_in_confirmed_after_sustained_speech", { callSid: session.callSid });
          if (responseInProgress) {
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          }
          assistantTtsInterrupted = true;
          ttsPlaybackGeneration += 1;
          if (streamSid) {
            twilioWs.send(JSON.stringify({
              event: "clear",
              streamSid
            }));
          }
          assistantAudioQueuedUntil = 0;
        }, 900);
      }
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      customerSpeechActive = false;
      clearTimeout(bargeInTimer);
    }

    if (event.type === "input_audio_buffer.speech_stopped" && !initialGreetingDone && !initialGreetingInProgress) {
      initialGreetingBlockedUntil = Date.now() + 900;
      scheduleInitialGreeting(1050);
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
        assistantTtsRemainder = assistantTextBuffer;
      }
      if (useElevenLabs && assistantTextBuffer.trim()) {
        const spokenText = assistantTextBuffer.trim();
        appendTranscript(session, "Martina", spokenText);
        queueSpeakableText({ flush: true });
        await assistantTtsQueue;
      }
      responseInProgress = false;
      responseStartedAt = 0;
      if (initialGreetingInProgress) {
        initialGreetingInProgress = false;
        initialGreetingDone = true;
        initialGreetingCompletedAt = Date.now();
        scheduleInitialGreetingRepeat();
      }
      waitingForCustomer = true;
      resetSilenceTimer();
      if (pendingToolResponseInstructions) {
        logEvent("openai_response_done", {
          status: event.response?.status,
          statusDetails: event.response?.status_details,
          outputTypes: event.response?.output?.map((item) => item.type),
          pendingToolResponse: true
        });
        flushPendingToolResponse("response_done_after_tool");
        return;
      }
      if (session.transferAfterResponse) {
        const transfer = session.transferAfterResponse;
        session.transferAfterResponse = null;
        const transferDelayMs = Math.max(
          4200,
          assistantAudioQueuedUntil - Date.now() + 2200,
          estimateSpeechMs(transfer.spokenReply || assistantTextBuffer) + 1200
        );
        logEvent("call_transfer_after_spoken_response", {
          callSid: session.callSid,
          transferDelayMs,
          language: transfer.language || ""
        });
        setTimeout(() => {
          transferActiveCall({
            callSid: session.callSid,
            from: session.from,
            reason: transfer.reason,
            language: transfer.language
          }).catch((error) => {
            logEvent("call_transfer_after_response_failed", {
              callSid: session.callSid,
              error: error.message
            });
            alertSeller("call_transfer_after_response_failed", {
              message: error.message,
              callSid: session.callSid,
              from: session.from
            });
          });
        }, transferDelayMs);
      }
      if (session.closeAfterResponse) {
        session.closeAfterResponse = false;
        logEvent("call_close_after_final_response", { callSid: session.callSid });
        setTimeout(() => {
          try {
            twilioWs.close(1000, "call completed");
          } catch {}
          try {
            openaiWs.close(1000, "call completed");
          } catch {}
        }, 650);
      }
      logEvent("openai_response_done", {
        status: event.response?.status,
        statusDetails: event.response?.status_details,
        outputTypes: event.response?.output?.map((item) => item.type)
      });
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await handleRealtimeToolCall(event, openaiWs, session, {
        requestToolResponse: (instructions, meta = {}) => {
          requestModelResponse(instructions, { ...meta, reason: "tool_output_ready" });
        },
        onSlowTool: async (toolName) => {
          if (!["cerca_auto", "controlla_disponibilita", "crea_appuntamento"].includes(toolName) || !twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;
          logEvent("tool_call_bridge_audio", { callSid: session.callSid, toolName });
          if (useElevenLabs && streamSid) {
            const bridgeText = toolName === "cerca_auto"
              ? "Un attimo, le dico cosa vedo."
              : toolName === "crea_appuntamento"
                ? "Sto inserendo la prenotazione, un attimo."
                : "Controllo l'agenda, un attimo.";
            await sendElevenLabsAudio(bridgeText);
            lastAssistantAudioAt = Date.now();
          }
        }
      });
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
    clearTimeout(bargeInTimer);
    sendFinalCallSummary(session);
    openaiWs.close();
  });
  openaiWs.on("close", () => {
    clearTimeout(silenceTimer);
    clearTimeout(initialGreetingTimer);
    clearTimeout(bargeInTimer);
    twilioWs.close();
  });
}

