import "dotenv/config";

const apiKey = process.env.DIDWW_API_KEY;
if (!apiKey) throw new Error("DIDWW_API_KEY mancante");

async function didww(path) {
  const response = await fetch(`https://api.didww.com/v3${path}`, {
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Api-Key": apiKey
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`DIDWW ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const result = await didww("/dids?include=voice_in_trunk&page[size]=100");
console.log(JSON.stringify({
  count: result.data?.length || 0,
  dids: (result.data || []).map((item) => ({
    id: item.id,
    type: item.type,
    attributes: item.attributes
  }))
}, null, 2));
