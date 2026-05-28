import "dotenv/config";

const baseUrl = process.env.PRODUCTION_BASE_URL || process.argv[2];
const adminToken = process.env.ADMIN_TOKEN;

if (!baseUrl) {
  throw new Error("Passa PRODUCTION_BASE_URL o il dominio come primo argomento.");
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {})
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
    throw new Error(`${path} -> ${response.status}: ${text}`);
  }
  return body;
}

async function check(name, fn) {
  try {
    const details = await fn();
    return { name, ok: true, details };
  } catch (error) {
    return { name, ok: false, error: error.message };
  }
}

const auth = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};

const results = [];
results.push(await check("health", () => request("/health")));
results.push(await check("inventory", () => request("/inventory/test?model=Q3")));
results.push(await check("calendar", () => request("/calendar/slots")));
results.push(await check("admin self-test", () => request("/admin/self-test", { headers: auth })));
results.push(await check("openai webhook endpoint", () => request("/openai/realtime/webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "test.ping" })
})));

console.log(JSON.stringify({
  ready: results.every((result) => result.ok),
  baseUrl,
  results
}, null, 2));

if (!results.every((result) => result.ok)) process.exit(1);
