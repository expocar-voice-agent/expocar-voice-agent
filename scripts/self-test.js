import "dotenv/config";
import http from "node:http";
import { once } from "node:events";
import twilio from "twilio";
import WebSocket from "ws";

const port = Number(process.env.PORT || 3000);
const baseUrl = `http://localhost:${port}`;
const adminToken = process.env.ADMIN_TOKEN || "";

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers: options.headers || {}
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function check(name, fn) {
  try {
    const details = await fn();
    return { name, ok: true, details };
  } catch (error) {
    return { name, ok: false, error: error.message || String(error), code: error.code };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function testOpenAIRealtime() {
  const apiKey = process.env.OPENAI_API_KEY;
  assert(apiKey, "OPENAI_API_KEY mancante");
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  const timer = setTimeout(() => {
    ws.close();
  }, 10000);

  try {
    await once(ws, "open");
    clearTimeout(timer);
    ws.close();
    return "connessione aperta";
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function testTwilioApi() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) {
    return "saltato: telefonia via DIDWW SIP diretto";
  }

  const client = twilio(accountSid, authToken);
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber, limit: 1 });
  assert(numbers.length > 0, `numero Twilio non trovato: ${fromNumber}`);
  return { phoneNumber: numbers[0].phoneNumber, sid: numbers[0].sid };
}

const results = [];

results.push(await check("server health", async () => {
  const res = await request("/health");
  assert(res.status === 200, `status ${res.status}`);
  return res.body.trim();
}));

results.push(await check("twilio greeting twiml", async () => {
  const res = await request("/twilio/voice-greeting", { method: "POST" });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.includes("Expocar, buongiorno, sono Marco"), "saluto mancante");
  return "saluto presente";
}));

results.push(await check("twilio stream twiml", async () => {
  const res = await request("/twilio/voice", {
    method: "POST",
    headers: {
      Host: "test.example",
      "X-Forwarded-Proto": "https"
    }
  });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.body.includes("wss://test.example/twilio/media"), "stream wss mancante");
  return "stream wss presente";
}));

results.push(await check("inventory", async () => {
  const res = await request("/inventory/test?model=Q3");
  assert(res.status === 200, `status ${res.status}`);
  const json = JSON.parse(res.body);
  assert(json.count > 0, "nessun annuncio trovato");
  return `${json.count} risultati`;
}));

results.push(await check("calendar", async () => {
  const res = await request("/calendar/slots");
  assert(res.status === 200, `status ${res.status}: ${res.body}`);
  const json = JSON.parse(res.body);
  assert(Array.isArray(json.slots), "slots non validi");
  return `${json.slots.length} slot`;
}));

results.push(await check("admin status", async () => {
  const headers = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  const res = await request("/admin/status", { headers });
  assert(res.status === 200, `status ${res.status}: ${res.body}`);
  const json = JSON.parse(res.body);
  assert(json.server?.ok, "server status non valido");
  return `porta ${json.server.port}`;
}));

results.push(await check("openai realtime", testOpenAIRealtime));
results.push(await check("twilio api", testTwilioApi));

console.log(JSON.stringify({
  ready: results.every((result) => result.ok),
  results
}, null, 2));

if (!results.every((result) => result.ok)) {
  process.exit(1);
}
