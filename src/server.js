import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import { google } from "googleapis";
import { config } from "./config.js";
import { acceptOpenAISipCall, bridgeTwilioToOpenAI, monitorOpenAISipCall } from "./realtimeBridge.js";
import { searchInventory } from "./inventory.js";
import { getAvailableSlots } from "./calendar.js";
import { getSimplyBookServices, getSimplyBookSlots, getSimplyBookUnits, simplyBookConfigured } from "./simplybook.js";
import { readRecentLeads } from "./leads.js";
import { notifySeller } from "./whatsapp.js";
import { logEvent } from "./logger.js";
import { alertSeller } from "./alerts.js";
import { getTelegramUpdates, notifySellerTelegram } from "./telegram.js";

const app = express();
const recordingCalls = new Map();

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
    inventory: { configured: Boolean(config.multigestionale.userApi) },
    simplybook: {
      configured: simplyBookConfigured(),
      companyLogin: config.simplybook.companyLogin,
      serviceId: config.simplybook.serviceId,
      unitIdConfigured: Boolean(config.simplybook.unitId)
    },
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
  res.json({
    ok: true,
    disabled: true,
    message: "WhatsApp cliente disattivato: conferme e promemoria sono gestiti da SimplyBook."
  });
});

app.get("/admin/test-appointment-whatsapp", requireAdmin, async (req, res) => {
  res.json({
    ok: true,
    disabled: true,
    message: "WhatsApp appuntamento disattivato: conferme e promemoria sono gestiti da SimplyBook."
  });
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

app.get("/admin/test-telegram", requireAdmin, async (_req, res) => {
  try {
    const message = await notifySellerTelegram({
      body: `Test Telegram ExpoCar: notifiche attive ${new Date().toISOString()}`
    });
    res.json({
      ok: !message.skipped,
      skipped: Boolean(message.skipped),
      messageId: message.message_id || null
    });
  } catch (error) {
    logEvent("admin_test_telegram_failed", { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/admin/telegram-updates", requireAdmin, async (_req, res) => {
  try {
    const result = await getTelegramUpdates();
    res.json({
      ok: !result.skipped,
      skipped: Boolean(result.skipped),
      updates: result.updates
    });
  } catch (error) {
    logEvent("admin_telegram_updates_failed", { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
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
    voiceMethod: "POST"
  });

  return {
    phoneNumber: updated.phoneNumber,
    voiceUrl: updated.voiceUrl,
    voiceMethod: updated.voiceMethod
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

  results.push(await runCheck("simplybook", async () => {
    const slots = await getSimplyBookSlots();
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
    const slots = simplyBookConfigured()
      ? await getSimplyBookSlots({ preferredDate: req.query.date })
      : await getAvailableSlots({ preferredDate: req.query.date });
    res.json({ slots });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/simplybook/services", requireAdmin, async (_req, res) => {
  try {
    const services = await getSimplyBookServices();
    res.json({ ok: true, services });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, code: error.code });
  }
});

app.get("/admin/simplybook/units", requireAdmin, async (_req, res) => {
  try {
    const units = await getSimplyBookUnits();
    res.json({ ok: true, units });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, code: error.code });
  }
});

app.get("/admin/simplybook/slots", requireAdmin, async (req, res) => {
  try {
    const slots = await getSimplyBookSlots({ preferredDate: req.query.date });
    res.json({ ok: true, slots });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, code: error.code });
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

function publicBaseFromRequest(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0];
  const proto = forwardedProto || (req.get("host")?.includes("trycloudflare.com") ? "https" : req.protocol);
  return `${proto}://${req.get("host")}`;
}

function recordingUrl(recordingSid, req) {
  const baseUrl = config.publicBaseUrl || publicBaseFromRequest(req);
  return `${baseUrl}/recordings/${encodeURIComponent(recordingSid)}.mp3`;
}

async function startCallRecording({ callSid, from, to, baseUrl }) {
  if (!callSid || !config.twilio.accountSid || !config.twilio.authToken) return;
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const recording = await client.calls(callSid).recordings.create({
    recordingStatusCallback: `${baseUrl}/twilio/recording-status`,
    recordingStatusCallbackMethod: "POST"
  });
  recordingCalls.set(callSid, { from, to, recordingSid: recording.sid });
  logEvent("twilio_recording_started", { callSid, recordingSid: recording.sid });
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
  const callSid = req.body?.CallSid || "";
  const from = req.body?.From || "";
  const to = req.body?.To || "";
  logEvent("twilio_voice_webhook", {
    callSid,
    from,
    to
  });

  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const httpBaseUrl = publicBaseFromRequest(req);
  const proto = httpBaseUrl.startsWith("https://") ? "https" : "http";
  const wsProtocol = proto === "https" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${req.get("host")}`;
  const stream = connect.stream({
    url: `${wsUrl}/twilio/media`,
    statusCallback: `${httpBaseUrl}/twilio/stream-status`,
    statusCallbackMethod: "POST"
  });
  stream.parameter({ name: "callSid", value: callSid });
  stream.parameter({ name: "from", value: from });
  stream.parameter({ name: "to", value: to });

  if (callSid) {
    recordingCalls.set(callSid, { from, to });
    setTimeout(() => {
      startCallRecording({ callSid, from, to, baseUrl: httpBaseUrl }).catch((error) => {
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
    }, 1200);
  }

  res.type("text/xml").send(response.toString());
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
  }, `${greetingForRome()}, Expocar Italia sono Marco. In cosa posso esserle utile?`);
  response.pause({ length: 1 });
  response.say({
    language: "it-IT",
    voice: "Polly.Giorgio"
  }, "Test saluto completato.");

  res.type("text/xml").send(response.toString());
});

app.post("/twilio/status", (req, res) => {
  logEvent("twilio_status", {
    callSid: req.body?.CallSid,
    callStatus: req.body?.CallStatus,
    callDuration: req.body?.CallDuration,
    from: req.body?.From,
    to: req.body?.To
  });
  res.json({ ok: true });
});

app.post("/twilio/stream-status", (req, res) => {
  logEvent("twilio_stream_status", req.body || {});
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

app.post("/twilio/recording-status", async (req, res) => {
  const callSid = req.body?.CallSid || "";
  const recordingSid = req.body?.RecordingSid || "";
  const recordingStatus = req.body?.RecordingStatus || "";
  const callInfo = recordingCalls.get(callSid) || {};
  logEvent("twilio_recording_status", {
    callSid,
    recordingSid,
    recordingStatus,
    recordingDuration: req.body?.RecordingDuration
  });

  if (recordingSid && recordingStatus === "completed") {
    recordingCalls.set(callSid, { ...callInfo, recordingSid });
    try {
      await notifySeller({
        body: [
          "Registrazione chiamata ExpoCar",
          callInfo.from ? `Cliente: ${callInfo.from}` : "",
          callSid ? `Call SID: ${callSid}` : "",
          req.body?.RecordingDuration ? `Durata registrazione: ${req.body.RecordingDuration} sec` : "",
          "",
          `Ascolta qui: ${recordingUrl(recordingSid, req)}`
        ].filter(Boolean).join("\n")
      });
      logEvent("twilio_recording_whatsapp_sent", { callSid, recordingSid });
    } catch (error) {
      logEvent("twilio_recording_whatsapp_failed", {
        callSid,
        recordingSid,
        error: error.message
      });
    }
  }

  res.json({ ok: true });
});

app.get("/recordings/:recordingSid.mp3", async (req, res, next) => {
  try {
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      res.status(503).send("Registrazioni non configurate.");
      return;
    }

    const recordingSid = req.params.recordingSid;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilio.accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!response.ok) {
      res.status(response.status).send("Registrazione non disponibile.");
      return;
    }

    const audio = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(audio);
  } catch (error) {
    next(error);
  }
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

wss.on("connection", (ws) => {
  logEvent("twilio_media_connected");
  bridgeTwilioToOpenAI(ws);
});

server.listen(config.port, () => {
  console.log(`Expocar voice agent listening on port ${config.port}`);
});
