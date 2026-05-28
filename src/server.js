import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import { google } from "googleapis";
import { config } from "./config.js";
import { agentInstructions } from "./agentPrompt.js";
import { acceptOpenAISipCall, bridgeTwilioToOpenAI, monitorOpenAISipCall } from "./realtimeBridge.js";
import { bridgeTwilioToCartesiaDemo } from "./cartesiaBridge.js";
import { searchInventory } from "./inventory.js";
import { getAvailableSlots } from "./calendar.js";
import { readRecentLeads } from "./leads.js";
import { notifySeller, sendAppointmentWhatsapp, sendCustomerAfterCallWhatsapp } from "./whatsapp.js";
import { logEvent } from "./logger.js";
import { alertSeller } from "./alerts.js";
import { markCallStatus, markStreamStatus, recentCallLifecycle, registerIncomingCall } from "./callLifecycle.js";

const app = express();
const voiceConversations = new Map();
const BUILD_VERSION = "2026-05-28-realtime-restored";
app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

app.use((req, _res, next) => {
  logEvent("http_request", {
    method: req.method,
    path: req.path,
    host: req.get("host"),
    forwardedProto: req.headers["x-forwarded-proto"],
    userAgent: req.headers["user-agent"]
  });
  next();
});

process.on("uncaughtException", (error) => {
  logEvent("uncaught_exception", { error: error.message, stack: error.stack });
  alertSeller("uncaught_exception", {
    message: error.message,
    details: { stack: error.stack }
  });
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logEvent("unhandled_rejection", { error: error.message, stack: error.stack });
  alertSeller("unhandled_rejection", {
    message: error.message,
    details: { stack: error.stack }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/admin/version", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    buildVersion: BUILD_VERSION,
    voiceMode: "openai_realtime_media_stream",
    cartesiaVoiceId: config.cartesia.voiceId,
    realtimeModel: config.openai.realtimeModel
  });
});

function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    next();
    return;
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token;
  if (token === config.adminToken) {
    next();
    return;
  }

  res.status(401).json({ error: "unauthorized" });
}

function decodeWebhookSecret(secret) {
  const value = String(secret || "");
  const encoded = value.startsWith("whsec_") ? value.slice("whsec_".length) : value;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return Buffer.from(value, "utf8");
  }
}

function verifyOpenAIWebhook(req) {
  if (!config.openai.webhookSecret) return { ok: true, skipped: true };

  const id = req.headers["webhook-id"];
  const timestamp = req.headers["webhook-timestamp"];
  const signatureHeader = String(req.headers["webhook-signature"] || "");
  const match = signatureHeader.match(/(?:^|,)v1,([^,\s]+)/);

  if (!id || !timestamp || !match) {
    return { ok: false, error: "missing webhook signature headers" };
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    req.rawBody || Buffer.from("")
  ]);
  const expected = crypto
    .createHmac("sha256", decodeWebhookSecret(config.openai.webhookSecret))
    .update(signedPayload)
    .digest("base64");

  const actual = match[1];
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  const ok = actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);

  return ok ? { ok: true } : { ok: false, error: "invalid webhook signature" };
}

function baseUrlFromRequest(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0];
  const proto = forwardedProto || (req.get("host")?.includes("trycloudflare.com") ? "https" : req.protocol);
  return `${proto}://${req.get("host")}`;
}

function recordingAccessToken(recordingSid) {
  const secret = config.adminToken || config.twilio.authToken || config.openai.apiKey;
  return crypto
    .createHmac("sha256", secret)
    .update(String(recordingSid || ""))
    .digest("hex")
    .slice(0, 32);
}

function verifyRecordingAccess(req, recordingSid) {
  const token = String(req.query.token || "");
  const expected = recordingAccessToken(recordingSid);
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  return tokenBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(tokenBuffer, expectedBuffer);
}

function getVoiceConversation(callSid) {
  if (!callSid) return [];
  if (!voiceConversations.has(callSid)) voiceConversations.set(callSid, []);
  return voiceConversations.get(callSid);
}

function cleanupVoiceConversation(callSid) {
  if (callSid) voiceConversations.delete(callSid);
}

function sayWithGather(response, { actionUrl, text }) {
  const gather = response.gather({
    input: "speech",
    action: actionUrl,
    method: "POST",
    language: "it-IT",
    speechTimeout: "auto",
    timeout: 6,
    actionOnEmptyResult: true
  });
  gather.say({
    language: "it-IT",
    voice: "Polly.Giorgio"
  }, text);
}

function trimForVoice(text, maxLength = 700) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3)}...`;
}

function extractResponseText(body) {
  if (body?.output_text) return body.output_text;
  const parts = [];
  for (const item of body?.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "text" && content.text) parts.push(content.text);
    }
  }
  return parts.join(" ");
}

function isClearGoodbye(text) {
  const clean = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!clean) return false;
  const words = clean.split(" ");
  if (words.length > 5) return false;
  return [
    "arrivederci",
    "ciao",
    "grazie ciao",
    "ciao grazie",
    "grazie arrivederci",
    "arrivederci grazie",
    "buona giornata",
    "buonasera",
    "a presto"
  ].includes(clean);
}

async function generateTurnBasedReply({ callSid, from, speech }) {
  const history = getVoiceConversation(callSid);
  if (speech) history.push({ role: "user", content: speech });

  const conversationText = history
    .slice(-8)
    .map((item) => `${item.role === "assistant" ? "Marco" : "Cliente"}: ${item.content}`)
    .join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openai.summaryModel,
        input: [
          {
            role: "system",
            content: [
              agentInstructions,
              "Sei al telefono in modalita a turni. Devi rispondere alla frase del cliente, non dire frasi generiche come 'mi dica pure' se il cliente ha gia fatto una domanda.",
              "Rispondi in italiano, massimo due frasi, poi fai una domanda concreta per proseguire solo se serve.",
              "Se il cliente chiede un'auto, cita che verifico lo stock o propongo importazione sopra 20.000 euro secondo le regole Expocar.",
              "Non chiudere la telefonata e non salutare, salvo congedo esplicito."
            ].join("\n")
          },
          {
            role: "user",
            content: [
              "Conversazione finora:",
              conversationText || "Nessuna.",
              "",
              `Ultima frase cliente: ${speech}`,
              "",
              "Risposta di Marco:"
            ].join("\n")
          }
        ],
        max_output_tokens: 220
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI turn reply failed ${response.status}: ${body.slice(0, 500)}`);
    }

    const body = await response.json();
    const rawText = extractResponseText(body);
    const text = trimForVoice(rawText || "Mi scusi, mi ripete la richiesta principale?");
    history.push({ role: "assistant", content: text });
    logEvent("twilio_turn_reply_generated", {
      callSid,
      from,
      speech: trimForVoice(speech, 300),
      reply: text,
      outputTextPresent: Boolean(body.output_text),
      outputItems: body.output?.length || 0
    });
    return text;
  } catch (error) {
    logEvent("twilio_turn_reply_failed", {
      callSid,
      from,
      error: error.message
    });
    alertSeller("twilio_turn_reply_failed", {
      message: error.message,
      callSid,
      from
    });
    return "Mi scusi, sto avendo un piccolo rallentamento tecnico. Mi dica nome, numero e richiesta principale: la faccio ricontattare subito da un consulente.";
  }
}

async function finalizeTurnBasedCall({ callSid, from }) {
  const history = getVoiceConversation(callSid);
  if (!history.length) return;

  const transcript = history
    .map((item) => `${item.role === "assistant" ? "Marco" : "Cliente"}: ${item.content}`)
    .join("\n");

  try {
    await notifySeller({
      body: [
        "Riepilogo chiamata Expocar",
        callSid ? `Call SID: ${callSid}` : "",
        from ? `Da: ${from}` : "",
        "",
        trimForVoice(transcript, 1400)
      ].filter(Boolean).join("\n")
    });
    logEvent("twilio_turn_summary_sent", { callSid, from });
  } catch (error) {
    logEvent("twilio_turn_summary_failed", { callSid, from, error: error.message });
  }

  try {
    await sendCustomerAfterCallWhatsapp({ to: from });
  } catch (error) {
    logEvent("twilio_turn_customer_whatsapp_failed", { callSid, from, error: error.message });
  }
}

function startCallRecordingAfterResponse({ callSid, from, httpBaseUrl }) {
  if (!callSid || !config.twilio.accountSid || !config.twilio.authToken) return;

  setTimeout(() => {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    client.calls(callSid).recordings.create({
      recordingChannels: "dual",
      recordingStatusCallback: `${httpBaseUrl}/twilio/recording-status`,
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["in-progress", "completed", "absent"]
    }).then((recording) => {
      logEvent("twilio_recording_started", {
        callSid,
        recordingSid: recording.sid
      });
    }).catch((error) => {
      logEvent("twilio_recording_start_failed", {
        callSid,
        error: error.message,
        code: error.code
      });
      alertSeller("twilio_recording_start_failed", {
        message: error.message,
        code: error.code,
        callSid,
        from
      });
    });
  }, 1500);
}

async function generateCartesiaDemoAudio(options = {}) {
  const transcript = options.text || config.cartesia.demoText || "Buongiorno, Expocar Italia, sono Marco. Non si preoccupi, penso a tutto io. Mi dica pure che auto sta cercando e la aiuto subito a trovare la soluzione migliore.";
  const modelId = options.modelId || config.cartesia.modelId;
  const voiceId = options.voiceId || config.cartesia.voiceId;
  const response = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.cartesia.apiKey}`,
      "X-API-Key": config.cartesia.apiKey,
      "Cartesia-Version": config.cartesia.version,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript,
      voice: {
        id: voiceId
      },
      language: "it",
      output_format: {
        container: "mp3",
        sample_rate: 44100,
        bit_rate: 64000
      }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`Cartesia audio failed ${response.status}: ${body.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }

  return {
    contentType: response.headers.get("content-type") || "audio/mpeg",
    buffer: Buffer.from(await response.arrayBuffer())
  };
}

function demoAudioPath() {
  return path.join(process.cwd(), "data", "cartesia-demo.mp3");
}

async function saveCartesiaDemoAudio(options = {}) {
  const audio = await generateCartesiaDemoAudio(options);
  fs.mkdirSync(path.dirname(demoAudioPath()), { recursive: true });
  fs.writeFileSync(demoAudioPath(), audio.buffer);
  logEvent("cartesia_demo_audio_saved", {
    contentType: audio.contentType,
    bytes: audio.buffer.length,
    modelId: options.modelId || config.cartesia.modelId,
    voiceId: options.voiceId || config.cartesia.voiceId
  });
  return audio;
}

async function listCartesiaVoices({ language = "it", limit = 50 } = {}) {
  const url = new URL("https://api.cartesia.ai/voices");
  if (language) url.searchParams.set("language", language);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.cartesia.apiKey}`,
      "X-API-Key": config.cartesia.apiKey,
      "Cartesia-Version": config.cartesia.version
    }
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    const error = new Error(`Cartesia voices failed ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }

  const voices = Array.isArray(body) ? body : (body.voices || body.data || []);
  return voices.map((voice) => ({
    id: voice.id,
    name: voice.name,
    description: voice.description,
    language: voice.language || voice.languages,
    gender: voice.gender,
    isOwner: voice.is_owner,
    isPublic: voice.is_public
  }));
}

app.get("/admin/status", requireAdmin, async (_req, res) => {
  const sipUri = config.openai.projectId
    ? `sip:${config.openai.projectId}@sip.api.openai.com;transport=tls`
    : "";
  const status = {
    server: { ok: true, port: config.port },
    publicBaseUrl: config.publicBaseUrl,
    openai: {
      configured: Boolean(config.openai.apiKey),
      projectIdConfigured: Boolean(config.openai.projectId),
      sipUriConfigured: Boolean(sipUri),
      webhookSecretConfigured: Boolean(config.openai.webhookSecret)
    },
    didww: {
      publicPhone: config.business.publicPhone,
      sipUri,
      webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/openai/realtime/webhook` : ""
    },
    twilio: {
      configured: Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber),
      fromNumber: config.twilio.fromNumber,
      whatsappConfigured: Boolean(config.twilio.whatsappFrom)
    },
    cartesia: {
      configured: Boolean(config.cartesia.apiKey),
      modelId: config.cartesia.modelId,
      voiceId: config.cartesia.voiceId,
      version: config.cartesia.version
    },
    inventory: { configured: Boolean(config.multigestionale.userApi) },
    googleCalendar: {
      mode: config.google.authMode,
      calendarId: config.google.calendarId,
      configured: Boolean(config.google.oauthClientId && config.google.oauthClientSecret && config.google.oauthRefreshToken)
    },
    recentLeads: readRecentLeads(5)
  };

  res.json(status);
});

app.get("/admin/logs", requireAdmin, (_req, res) => {
  try {
    const logPath = "data/server.log";
    const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const lines = content.trim().split(/\r?\n/).filter(Boolean).slice(-100);
    res.type("text/plain").send(lines.join("\n"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/admin/call-lifecycle", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    calls: recentCallLifecycle(Number(req.query.limit) || 20)
  });
});

app.get("/debug/logs", requireAdmin, (_req, res) => {
  try {
    const logPath = "data/server.log";
    const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const lines = content.trim().split(/\r?\n/).filter(Boolean).slice(-200);
    res.type("text/plain").send(lines.join("\n"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/admin/test-whatsapp", requireAdmin, async (req, res) => {
  try {
    const body = req.body?.body || `Test WhatsApp Expocar: sistema notifiche attivo ${new Date().toISOString()}`;
    const message = await notifySeller({ body });
    res.json({
      ok: !message.skipped,
      skipped: Boolean(message.skipped),
      sid: message.sid || null
    });
  } catch (error) {
    logEvent("admin_test_whatsapp_failed", { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/admin/test-whatsapp", requireAdmin, async (req, res) => {
  try {
    const body = req.query.body || `Test WhatsApp Expocar: sistema notifiche attivo ${new Date().toISOString()}`;
    const message = await notifySeller({ body });
    res.json({
      ok: !message.skipped,
      skipped: Boolean(message.skipped),
      sid: message.sid || null
    });
  } catch (error) {
    logEvent("admin_test_whatsapp_failed", { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/admin/test-customer-whatsapp", requireAdmin, async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) {
      res.status(400).json({ ok: false, error: "missing to query parameter, example: ?to=+393711938885" });
      return;
    }

    const message = await sendCustomerAfterCallWhatsapp({ to });
    res.json({
      ok: !message.skipped,
      skipped: Boolean(message.skipped),
      to,
      sid: message.sid || null
    });
  } catch (error) {
    logEvent("admin_test_customer_whatsapp_failed", {
      to: req.query.to,
      error: error.message,
      code: error.code,
      status: error.status
    });
    res.status(500).json({
      ok: false,
      to: req.query.to,
      error: error.message,
      code: error.code,
      status: error.status
    });
  }
});

app.get("/admin/test-appointment-whatsapp", requireAdmin, async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) {
      res.status(400).json({ ok: false, error: "missing to query parameter, example: ?to=+393711938885" });
      return;
    }

    const startTime = req.query.startTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const message = await sendAppointmentWhatsapp({
      to,
      name: req.query.name || "cliente",
      startTime
    });
    res.json({
      ok: !message.skipped,
      skipped: Boolean(message.skipped),
      to,
      sid: message.sid || null
    });
  } catch (error) {
    logEvent("admin_test_appointment_whatsapp_failed", {
      to: req.query.to,
      error: error.message,
      code: error.code,
      status: error.status
    });
    res.status(500).json({
      ok: false,
      to: req.query.to,
      error: error.message,
      code: error.code,
      status: error.status
    });
  }
});

app.get("/admin/test-alert", requireAdmin, async (req, res) => {
  const result = await alertSeller("test_alert", {
    message: "Test alert sistema Expocar",
    path: "/admin/test-alert"
  });
  res.json({
    ok: !result.skipped,
    skipped: Boolean(result.skipped),
    throttled: Boolean(result.throttled),
    sid: result.sid || null
  });
});

async function runCheck(name, fn) {
  try {
    const details = await fn();
    return { name, ok: true, details };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error.message || String(error),
      code: error.code
    };
  }
}

async function testOpenAIRealtime() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.openai.realtimeModel)}`,
      { headers: { Authorization: `Bearer ${config.openai.apiKey}` } }
    );

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout"));
    }, 10000);

    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve("connessione aperta");
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function testOpenAIRealtimeDetailed() {
  return new Promise((resolve, reject) => {
    const model = config.openai.realtimeModel;
    const startedAt = Date.now();
    const events = [];
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      { headers: { Authorization: `Bearer ${config.openai.apiKey}` } }
    );

    const timer = setTimeout(() => {
      events.push({ type: "timeout", elapsedMs: Date.now() - startedAt });
      ws.close();
      reject(new Error(`OpenAI realtime timeout: ${JSON.stringify(events)}`));
    }, 12000);

    ws.on("open", () => {
      events.push({ type: "open", elapsedMs: Date.now() - startedAt });
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model,
          output_modalities: ["audio"],
          audio: {
            input: { format: { type: "audio/pcmu" } },
            output: { format: { type: "audio/pcmu" }, voice: config.openai.voice }
          }
        }
      }));
    });

    ws.on("message", (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        event = { type: "unparseable" };
      }

      events.push({
        type: event.type,
        error: event.error,
        elapsedMs: Date.now() - startedAt
      });

      if (event.type === "session.created" || event.type === "session.updated") {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: true, model, voice: config.openai.voice, events });
      }

      if (event.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`OpenAI realtime error: ${JSON.stringify(event.error)}`));
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      events.push({ type: "error", message: error.message, elapsedMs: Date.now() - startedAt });
      reject(error);
    });
  });
}

async function testTwilioApi() {
  if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.fromNumber) {
    return "Twilio non configurato, test saltato";
  }

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const numbers = await client.incomingPhoneNumbers.list({
    phoneNumber: config.twilio.fromNumber,
    limit: 1
  });

  if (!numbers.length) {
    throw new Error(`numero Twilio non trovato: ${config.twilio.fromNumber}`);
  }

  return { phoneNumber: numbers[0].phoneNumber };
}

async function updateTwilioWebhook(baseUrl = config.publicBaseUrl) {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const numbers = await client.incomingPhoneNumbers.list({
    phoneNumber: config.twilio.fromNumber,
    limit: 1
  });

  if (!numbers.length) {
    throw new Error(`numero Twilio non trovato: ${config.twilio.fromNumber}`);
  }

  const updated = await client.incomingPhoneNumbers(numbers[0].sid).update({
    voiceUrl: `${baseUrl}/twilio/voice`,
    voiceMethod: "POST",
    statusCallback: `${baseUrl}/twilio/status`,
    statusCallbackMethod: "POST"
  });

  return {
    phoneNumber: updated.phoneNumber,
    voiceUrl: updated.voiceUrl,
    voiceMethod: updated.voiceMethod,
    statusCallback: updated.statusCallback,
    statusCallbackMethod: updated.statusCallbackMethod
  };
}

async function createTestCall(baseUrl = config.publicBaseUrl) {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const call = await client.calls.create({
    from: config.twilio.fromNumber,
    to: config.twilio.sellerWhatsappTo.replace(/^whatsapp:/, ""),
    url: `${baseUrl}/twilio/voice`,
    method: "POST",
    statusCallback: `${baseUrl}/twilio/status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
  });

  return {
    sid: call.sid,
    status: call.status,
    from: call.from,
    to: call.to
  };
}

async function createCartesiaDemoCall({ baseUrl = config.publicBaseUrl, to, modelId, voiceId, text } = {}) {
  if (!config.cartesia.apiKey) {
    throw new Error("Manca CARTESIA_API_KEY su Render.");
  }
  if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.fromNumber) {
    throw new Error("Twilio non configurato.");
  }

  await saveCartesiaDemoAudio({ modelId, voiceId, text });

  const destination = to || config.twilio.sellerWhatsappTo.replace(/^whatsapp:/, "");
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const call = await client.calls.create({
    from: config.twilio.fromNumber,
    to: destination,
    url: `${baseUrl}/twilio/cartesia-demo`,
    method: "POST",
    statusCallback: `${baseUrl}/twilio/status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
  });

  return {
    sid: call.sid,
    status: call.status,
    from: call.from,
    to: call.to
  };
}

function serializeTwilioNumber(number) {
  return {
    phoneNumber: number.phoneNumber,
    friendlyName: number.friendlyName,
    locality: number.locality,
    region: number.region,
    isoCountry: number.isoCountry,
    postalCode: number.postalCode,
    addressRequirements: number.addressRequirements,
    capabilities: number.capabilities
  };
}

function getAvailableNumberResource(client, country, type) {
  const resources = client.availablePhoneNumbers(country);
  if (type === "mobile") return resources.mobile;
  if (type === "tollFree") return resources.tollFree;
  return resources.local;
}

async function searchAvailableTwilioNumbers({
  country = "IT",
  type = "local",
  areaCode = "080",
  contains,
  limit = 20
} = {}) {
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const query = {
    voiceEnabled: true,
    limit: Math.min(Number(limit) || 20, 50)
  };

  if (areaCode) query.areaCode = areaCode;
  if (contains) query.contains = contains;

  const numbers = await getAvailableNumberResource(client, country, type).list(query);
  return numbers.map(serializeTwilioNumber);
}

async function purchaseTwilioNumber({ phoneNumber, baseUrl = config.publicBaseUrl }) {
  if (!phoneNumber) {
    throw new Error("phoneNumber required");
  }

  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber,
    friendlyName: "Expocar Marco",
    voiceUrl: `${baseUrl}/twilio/voice`,
    voiceMethod: "POST",
    statusCallback: `${baseUrl}/twilio/status`,
    statusCallbackMethod: "POST"
  });

  upsertEnvValue("TWILIO_FROM_NUMBER", purchased.phoneNumber);

  return {
    phoneNumber: purchased.phoneNumber,
    sid: purchased.sid,
    voiceUrl: purchased.voiceUrl,
    voiceMethod: purchased.voiceMethod,
    statusCallback: purchased.statusCallback
  };
}

app.get("/admin/self-test", requireAdmin, async (_req, res) => {
  const results = [];

  results.push(await runCheck("inventory", async () => {
    const cars = await searchInventory({ model: "Q3" });
    if (!cars.length) throw new Error("nessun annuncio trovato");
    return `${cars.length} risultati`;
  }));

  results.push(await runCheck("calendar", async () => {
    const slots = await getAvailableSlots();
    return `${slots.length} slot`;
  }));

  results.push(await runCheck("openai realtime", testOpenAIRealtime));
  if (config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber) {
    results.push(await runCheck("twilio api", testTwilioApi));
  } else {
    results.push({ name: "twilio api", ok: true, details: "saltato: telefonia via DIDWW SIP diretto" });
  }

  res.json({
    ready: results.every((result) => result.ok),
    results
  });
});

app.get("/admin/openai-realtime-check", requireAdmin, async (_req, res) => {
  try {
    const result = await testOpenAIRealtimeDetailed();
    res.json(result);
  } catch (error) {
    logEvent("openai_realtime_check_failed", { error: error.message });
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/admin/twilio-available-numbers", requireAdmin, async (req, res) => {
  try {
    const numbers = await searchAvailableTwilioNumbers(req.query);
    res.json({
      ok: true,
      count: numbers.length,
      numbers
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code,
      status: error.status
    });
  }
});

app.get("/admin/twilio-country/:country", requireAdmin, async (req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const country = await client.availablePhoneNumbers(req.params.country).fetch();
    res.json({
      ok: true,
      countryCode: country.countryCode,
      country: country.country,
      beta: country.beta,
      subresourceUris: country.subresourceUris
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code,
      status: error.status
    });
  }
});

app.post("/admin/purchase-twilio-number", requireAdmin, async (req, res) => {
  try {
    const purchased = await purchaseTwilioNumber({
      phoneNumber: req.query.phoneNumber || req.body?.phoneNumber,
      baseUrl: req.query.baseUrl || req.body?.baseUrl || config.publicBaseUrl
    });
    logEvent("twilio_number_purchased", purchased);
    res.json({ ok: true, purchased });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code,
      status: error.status,
      moreInfo: error.moreInfo
    });
  }
});

app.post("/admin/update-twilio-webhook", requireAdmin, async (req, res) => {
  try {
    const updated = await updateTwilioWebhook(req.query.baseUrl || config.publicBaseUrl);
    logEvent("twilio_webhook_updated", updated);
    res.json({ ok: true, updated });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/update-twilio-webhook", requireAdmin, async (req, res) => {
  try {
    const updated = await updateTwilioWebhook(req.query.baseUrl || config.publicBaseUrl);
    logEvent("twilio_webhook_updated", updated);
    res.json({ ok: true, updated });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code
    });
  }
});

app.post("/admin/test-call", requireAdmin, async (req, res) => {
  try {
    const call = await createTestCall(req.query.baseUrl || config.publicBaseUrl);
    logEvent("twilio_test_call_created", call);
    res.json({ ok: true, call });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/cartesia-demo-call", requireAdmin, async (req, res) => {
  try {
    const call = await createCartesiaDemoCall({
      baseUrl: req.query.baseUrl || config.publicBaseUrl,
      to: req.query.to,
      modelId: req.query.modelId,
      voiceId: req.query.voiceId,
      text: req.query.text
    });
    logEvent("cartesia_demo_call_created", call);
    res.json({ ok: true, call });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/cartesia-demo-audio-check", requireAdmin, async (req, res) => {
  try {
    const audio = await saveCartesiaDemoAudio({
      modelId: req.query.modelId,
      voiceId: req.query.voiceId,
      text: req.query.text
    });
    res.json({
      ok: true,
      voiceId: req.query.voiceId || config.cartesia.voiceId,
      modelId: req.query.modelId || config.cartesia.modelId,
      contentType: audio.contentType,
      bytes: audio.buffer.length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      status: error.status
    });
  }
});

app.get("/admin/cartesia-voices", requireAdmin, async (req, res) => {
  try {
    const voices = await listCartesiaVoices({
      language: req.query.language || "it",
      limit: req.query.limit || 50
    });
    res.json({
      ok: true,
      count: voices.length,
      voices
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      status: error.status
    });
  }
});

app.get("/admin/call/:sid", requireAdmin, async (req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const call = await client.calls(req.params.sid).fetch();
    res.json({
      sid: call.sid,
      status: call.status,
      from: call.from,
      to: call.to,
      duration: call.duration,
      startTime: call.startTime,
      endTime: call.endTime,
      price: call.price,
      direction: call.direction
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/twilio-number", requireAdmin, async (_req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const numbers = await client.incomingPhoneNumbers.list({
      phoneNumber: config.twilio.fromNumber,
      limit: 1
    });

    if (!numbers.length) {
      res.status(404).json({ error: `numero non trovato: ${config.twilio.fromNumber}` });
      return;
    }

    const number = numbers[0];
    res.json({
      phoneNumber: number.phoneNumber,
      sid: number.sid,
      capabilities: number.capabilities,
      voiceUrl: number.voiceUrl,
      voiceMethod: number.voiceMethod,
      statusCallback: number.statusCallback
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/recent-calls", requireAdmin, async (_req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const calls = await client.calls.list({ limit: 10 });
    res.json(calls.map((call) => ({
      sid: call.sid,
      status: call.status,
      direction: call.direction,
      from: call.from,
      to: call.to,
      duration: call.duration,
      startTime: call.startTime,
      endTime: call.endTime,
      price: call.price
    })));
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/twilio-alerts", requireAdmin, async (_req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const alerts = await client.monitor.v1.alerts.list({ limit: 10 });
    res.json(alerts.map((alert) => ({
      sid: alert.sid,
      errorCode: alert.errorCode,
      logLevel: alert.logLevel,
      message: alert.moreInfo,
      requestUrl: alert.requestUrl,
      requestMethod: alert.requestMethod,
      resourceSid: alert.resourceSid,
      dateCreated: alert.dateCreated
    })));
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

app.post("/admin/verify-caller", requireAdmin, async (req, res) => {
  try {
    const phoneNumber = req.query.phoneNumber;
    if (!phoneNumber) {
      res.status(400).json({ error: "phoneNumber query parameter required" });
      return;
    }

    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const validation = await client.validationRequests.create({
      phoneNumber,
      friendlyName: `Caller ${phoneNumber}`
    });

    res.json({
      ok: true,
      phoneNumber,
      validationCode: validation.validationCode,
      callSid: validation.callSid
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code
    });
  }
});

app.get("/admin/verified-callers", requireAdmin, async (_req, res) => {
  try {
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const callerIds = await client.outgoingCallerIds.list({ limit: 20 });
    res.json(callerIds.map((callerId) => ({
      sid: callerId.sid,
      phoneNumber: callerId.phoneNumber,
      friendlyName: callerId.friendlyName,
      dateCreated: callerId.dateCreated
    })));
  } catch (error) {
    res.status(500).json({
      error: error.message,
      code: error.code
    });
  }
});

app.get("/inventory/test", async (req, res, next) => {
  try {
    const results = await searchInventory(req.query);
    res.json({ count: results.length, results });
  } catch (error) {
    next(error);
  }
});

app.get("/calendar/slots", async (req, res, next) => {
  try {
    const slots = await getAvailableSlots({ preferredDate: req.query.date });
    res.json({ slots });
  } catch (error) {
    next(error);
  }
});

function getGoogleRedirectUri(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0];
  const proto = forwardedProto || (req.get("host")?.includes("trycloudflare.com") ? "https" : req.protocol);
  const baseUrl = `${proto}://${req.get("host")}`;
  return `${baseUrl}/google/oauth/callback`;
}

function getOAuthClient(req) {
  return new google.auth.OAuth2(
    config.google.oauthClientId,
    config.google.oauthClientSecret,
    getGoogleRedirectUri(req)
  );
}

function upsertEnvValue(key, value) {
  const envPath = path.join(process.cwd(), ".env");
  const escaped = String(value).replace(/\r?\n/g, "\\n");
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${escaped}`;

  if (current.match(new RegExp(`^${key}=.*$`, "m"))) {
    fs.writeFileSync(envPath, current.replace(new RegExp(`^${key}=.*$`, "m"), line));
    return;
  }

  fs.writeFileSync(envPath, `${current.trimEnd()}\n${line}\n`);
}

app.get("/google/auth", (req, res) => {
  const oauth2Client = getOAuthClient(req);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"]
  });

  res.redirect(url);
});

app.get("/google/oauth/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      res.status(400).send(`Google OAuth error: ${req.query.error}`);
      return;
    }

    const oauth2Client = getOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(req.query.code);

    if (!tokens.refresh_token) {
      res.status(400).send("Autorizzazione completata, ma Google non ha restituito un refresh token. Riapri /google/auth e riprova.");
      return;
    }

    upsertEnvValue("GOOGLE_OAUTH_REFRESH_TOKEN", tokens.refresh_token);
    res.send("Google Calendar autorizzato. Puoi chiudere questa finestra e riavviare il server.");
  } catch (error) {
    next(error);
  }
});

app.post("/twilio/voice", (req, res) => {
  logEvent("twilio_voice_webhook", {
    callSid: req.body?.CallSid,
    from: req.body?.From,
    to: req.body?.To
  });
  registerIncomingCall(req.body || {});

  const httpBaseUrl = baseUrlFromRequest(req);
  const response = new twilio.twiml.VoiceResponse();
  const proto = httpBaseUrl.startsWith("https://") ? "https" : "http";
  const wsProtocol = proto === "https" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${req.get("host")}`;
  const connect = response.connect();
  const stream = connect.stream({
    url: `${wsUrl}/twilio/media`,
    statusCallback: `${httpBaseUrl}/twilio/stream-status`,
    statusCallbackMethod: "POST"
  });
  stream.parameter({ name: "callSid", value: req.body?.CallSid || "" });
  stream.parameter({ name: "from", value: req.body?.From || "" });
  stream.parameter({ name: "to", value: req.body?.To || "" });

  const twiml = response.toString();
  logEvent("twilio_voice_twiml_generated", {
    callSid: req.body?.CallSid,
    mode: "openai_realtime_media_stream",
    streamUrl: `${wsUrl}/twilio/media`
  });
  res.type("text/xml").send(twiml);

  startCallRecordingAfterResponse({
    callSid: req.body?.CallSid,
    from: req.body?.From,
    httpBaseUrl
  });
});

app.post("/twilio/voice-greeting", (req, res) => {
  logEvent("twilio_voice_greeting_webhook", {
    callSid: req.body?.CallSid,
    from: req.body?.From,
    to: req.body?.To
  });

  const response = new twilio.twiml.VoiceResponse();
  response.say({
    language: "it-IT",
    voice: "Polly.Giorgio"
  }, "Expocar, buongiorno, sono Marco. In cosa posso esserle utile?");
  response.pause({ length: 1 });
  response.say({
    language: "it-IT",
    voice: "Polly.Giorgio"
  }, "Test saluto completato.");

  res.type("text/xml").send(response.toString());
});

app.post("/twilio/gather", async (req, res) => {
  const callSid = req.body?.CallSid;
  const from = req.body?.From || req.body?.Caller;
  const speech = String(req.body?.SpeechResult || "").trim();
  const httpBaseUrl = baseUrlFromRequest(req);

  logEvent("twilio_gather_result", {
    callSid,
    from,
    speech,
    confidence: req.body?.Confidence
  });

  const response = new twilio.twiml.VoiceResponse();

  if (!speech) {
    sayWithGather(response, {
      actionUrl: `${httpBaseUrl}/twilio/gather`,
      text: "Mi scusi, non ho sentito bene. Mi ripete per favore?"
    });
    response.redirect({ method: "POST" }, `${httpBaseUrl}/twilio/gather`);
    res.type("text/xml").send(response.toString());
    return;
  }

  if (isClearGoodbye(speech)) {
    response.say({
      language: "it-IT",
      voice: "Polly.Giorgio"
    }, "Grazie per aver contattato Expocar Italia. A presto.");
    response.hangup();
    res.type("text/xml").send(response.toString());
    return;
  }

  const reply = await generateTurnBasedReply({ callSid, from, speech });
  sayWithGather(response, {
    actionUrl: `${httpBaseUrl}/twilio/gather`,
    text: reply
  });
  response.redirect({ method: "POST" }, `${httpBaseUrl}/twilio/gather`);

  res.type("text/xml").send(response.toString());
});

app.post("/twilio/cartesia-demo", (req, res) => {
  logEvent("twilio_cartesia_demo_webhook", {
    callSid: req.body?.CallSid,
    from: req.body?.From,
    to: req.body?.To
  });

  const response = new twilio.twiml.VoiceResponse();
  const httpBaseUrl = baseUrlFromRequest(req);
  response.play(`${httpBaseUrl}/cartesia/demo-audio.mp3?t=${Date.now()}`);
  response.pause({ length: 1 });

  res.type("text/xml").send(response.toString());
});

app.get("/cartesia/demo-audio.mp3", async (_req, res) => {
  try {
    if (!fs.existsSync(demoAudioPath())) {
      await saveCartesiaDemoAudio();
    }
    const audio = fs.readFileSync(demoAudioPath());
    logEvent("cartesia_demo_audio_served", { bytes: audio.length });
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(audio);
  } catch (error) {
    logEvent("cartesia_demo_audio_error", {
      message: error.message,
      status: error.status
    });
    alertSeller("cartesia_demo_audio_error", {
      message: error.message,
      code: error.status
    });
    res.status(500).send("Errore generazione audio Cartesia.");
  }
});

app.post("/twilio/status", async (req, res) => {
  logEvent("twilio_status", {
    callSid: req.body?.CallSid,
    callStatus: req.body?.CallStatus,
    callDuration: req.body?.CallDuration,
    from: req.body?.From,
    to: req.body?.To
  });
  await markCallStatus(req.body || {});
  if (["completed", "failed", "busy", "no-answer", "canceled"].includes(String(req.body?.CallStatus || "").toLowerCase())) {
    await finalizeTurnBasedCall({
      callSid: req.body?.CallSid,
      from: req.body?.From
    });
    cleanupVoiceConversation(req.body?.CallSid);
  }
  res.json({ ok: true });
});

app.post("/twilio/stream-status", (req, res) => {
  logEvent("twilio_stream_status", req.body || {});
  markStreamStatus(req.body || {});
  res.json({ ok: true });
});

app.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const recordingSid = req.params.recordingSid;
  try {
    if (!verifyRecordingAccess(req, recordingSid)) {
      res.status(401).send("Link registrazione non valido.");
      return;
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Recordings/${recordingSid}.mp3`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64")}`
      }
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logEvent("twilio_recording_proxy_failed", {
        recordingSid,
        status: response.status,
        body: body.slice(0, 500)
      });
      res.status(response.status).send("Registrazione non ancora disponibile o non trovata.");
      return;
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Content-Disposition", `inline; filename="${recordingSid}.mp3"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    logEvent("twilio_recording_proxy_error", {
      recordingSid,
      error: error.message
    });
    alertSeller("twilio_recording_proxy_error", {
      message: error.message,
      code: error.code
    });
    res.status(500).send("Errore durante il recupero della registrazione.");
  }
});

app.post("/twilio/recording-status", async (req, res) => {
  const recordingUrl = req.body?.RecordingUrl;
  const recordingSid = req.body?.RecordingSid;
  const callSid = req.body?.CallSid;
  const status = req.body?.RecordingStatus;
  logEvent("twilio_recording_status", {
    callSid,
    recordingSid,
    recordingStatus: status,
    recordingUrl,
    recordingDuration: req.body?.RecordingDuration
  });

  if (status === "completed" && recordingUrl) {
    try {
      const publicRecordingUrl = recordingSid
        ? `${baseUrlFromRequest(req)}/recordings/${recordingSid}.mp3?token=${recordingAccessToken(recordingSid)}`
        : `${recordingUrl}.mp3`;
      await notifySeller({
        body: [
          "Registrazione chiamata Expocar disponibile",
          callSid ? `Call SID: ${callSid}` : "",
          recordingSid ? `Recording SID: ${recordingSid}` : "",
          req.body?.RecordingDuration ? `Durata: ${req.body.RecordingDuration} sec` : "",
          publicRecordingUrl
        ].filter(Boolean).join("\n")
      });
    } catch (error) {
      logEvent("twilio_recording_whatsapp_failed", {
        callSid,
        recordingSid,
        error: error.message
      });
    }
  }

  if (status === "absent") {
    alertSeller("twilio_recording_absent", {
      message: "Registrazione assente o non disponibile.",
      callSid,
      details: req.body
    });
  }

  res.json({ ok: true });
});

app.post("/twilio/message-status", (req, res) => {
  const messageStatus = req.body?.MessageStatus || req.body?.SmsStatus;
  const errorCode = req.body?.ErrorCode;
  logEvent("twilio_message_status", {
    messageSid: req.body?.MessageSid || req.body?.SmsSid,
    messageStatus,
    errorCode,
    errorMessage: req.body?.ErrorMessage,
    to: req.body?.To,
    from: req.body?.From,
    channelPrefix: req.body?.ChannelPrefix,
    accountSid: req.body?.AccountSid
  });
  if (errorCode || ["failed", "undelivered"].includes(String(messageStatus || "").toLowerCase())) {
    alertSeller("twilio_message_delivery_error", {
      message: req.body?.ErrorMessage || messageStatus,
      code: errorCode,
      from: req.body?.From,
      to: req.body?.To,
      details: req.body
    });
  }
  res.json({ ok: true });
});

app.post("/openai/realtime/webhook", async (req, res, next) => {
  try {
    const signature = verifyOpenAIWebhook(req);
    if (!signature.ok) {
      res.status(400).json({ ok: false, error: signature.error });
      return;
    }

    const event = req.body;

    if (event?.type !== "realtime.call.incoming") {
      res.json({ ok: true, ignored: true });
      return;
    }

    const callId = event.data?.call_id || event.data?.id || event.call_id;
    if (!callId) {
      console.error("OpenAI realtime webhook missing call_id", JSON.stringify(event));
      res.status(400).json({ ok: false, error: "call_id missing" });
      return;
    }

    console.log(`OpenAI realtime incoming call: ${callId}`);
    logEvent("openai_sip_incoming_call", {
      callId,
      sipHeaders: event.data?.sip_headers
    });

    res.json({ ok: true, callId });

    acceptOpenAISipCall(callId)
      .then(() => {
        monitorOpenAISipCall(callId);
      })
      .catch((error) => {
        console.error(error);
        logEvent("openai_sip_accept_error", {
          callId,
          message: error.message,
          code: error.code
        });
        alertSeller("openai_sip_accept_error", {
          message: error.message,
          code: error.code,
          callSid: callId
        });
      });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, _next) => {
  console.error(error);
  logEvent("express_error", {
    path: req.path,
    method: req.method,
    message: error.message,
    code: error.code
  });
  alertSeller("express_error", {
    path: req.path,
    message: error.message,
    code: error.code
  });
  res.status(500).json({ error: error.message });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/media" });
const cartesiaDemoWss = new WebSocketServer({ server, path: "/cartesia/demo-media" });

wss.on("connection", (ws) => {
  logEvent("twilio_media_connected");
  bridgeTwilioToOpenAI(ws);
});

cartesiaDemoWss.on("connection", (ws) => {
  logEvent("cartesia_demo_media_connected");
  bridgeTwilioToCartesiaDemo(ws);
});

server.listen(config.port, () => {
  console.log(`Expocar voice agent listening on port ${config.port}`);
});
