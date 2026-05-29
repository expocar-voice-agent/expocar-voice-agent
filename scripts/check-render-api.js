import "dotenv/config";

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) throw new Error("RENDER_API_KEY mancante");

async function render(path, options = {}) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

const owners = await render("/owners");
const services = await render("/services?limit=20");

console.log(JSON.stringify({
  ok: true,
  owners,
  services: services.map?.((item) => ({
    id: item.service?.id || item.id,
    name: item.service?.name || item.name,
    type: item.service?.type || item.type,
    serviceDetails: item.service?.serviceDetails || item.serviceDetails
  })) || services
}, null, 2));
