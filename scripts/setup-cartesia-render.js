import "dotenv/config";

const requiredKeys = [
  "RENDER_API_KEY",
  "CARTESIA_API_KEY",
  "CARTESIA_MODEL_ID",
  "CARTESIA_VOICE_ID",
  "CARTESIA_VERSION"
];

for (const key of requiredKeys) {
  if (!process.env[key]) throw new Error(`${key} mancante nel file .env`);
}

const renderApiKey = process.env.RENDER_API_KEY;
const serviceName = process.env.RENDER_SERVICE_NAME || "expocar-voice-agent";

async function render(path, options = {}) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${renderApiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers
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
    throw new Error(`Render ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function serviceRecordName(item) {
  return item.service?.name || item.name || "";
}

function serviceRecordId(item) {
  return item.service?.id || item.id;
}

async function findService() {
  const services = await render("/services?limit=100");
  const records = Array.isArray(services) ? services : [];
  const exact = records.find((item) => serviceRecordName(item) === serviceName);
  if (exact) return exact;

  const partial = records.find((item) => serviceRecordName(item).includes(serviceName));
  if (partial) return partial;

  throw new Error(`Servizio Render non trovato: ${serviceName}`);
}

async function upsertEnvVar(serviceId, key, value) {
  await render(`/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value })
  });
  console.log(`Aggiornata variabile ${key}`);
}

const service = await findService();
const serviceId = serviceRecordId(service);
const name = serviceRecordName(service);

console.log(`Servizio Render trovato: ${name} (${serviceId})`);

const cartesiaVars = {
  CARTESIA_API_KEY: process.env.CARTESIA_API_KEY,
  CARTESIA_MODEL_ID: process.env.CARTESIA_MODEL_ID,
  CARTESIA_VOICE_ID: process.env.CARTESIA_VOICE_ID,
  CARTESIA_VERSION: process.env.CARTESIA_VERSION,
  CARTESIA_DEMO_TEXT: process.env.CARTESIA_DEMO_TEXT || ""
};

for (const [key, value] of Object.entries(cartesiaVars)) {
  await upsertEnvVar(serviceId, key, value);
}

const deploy = await render(`/services/${serviceId}/deploys`, {
  method: "POST",
  body: JSON.stringify({ clearCache: "do_not_clear" })
});

console.log(JSON.stringify({
  ok: true,
  service: name,
  serviceId,
  deployId: deploy.id || deploy.deploy?.id || null,
  message: "Cartesia Sonic configurato su Render. Deploy avviato."
}, null, 2));
