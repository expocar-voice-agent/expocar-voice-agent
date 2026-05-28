import "dotenv/config";

const apiKey = process.env.DIDWW_API_KEY;
const didNumber = process.env.DIDWW_DID_NUMBER || process.env.BUSINESS_PUBLIC_PHONE || "+390809997271";
const projectId = process.env.OPENAI_PROJECT_ID;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function didww(path, options = {}) {
  assert(apiKey, "DIDWW_API_KEY mancante");

  const response = await fetch(`https://api.didww.com/v3${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Api-Key": apiKey,
      ...options.headers
    }
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`DIDWW ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

async function findDid() {
  const wantedDigits = normalizePhone(didNumber).replace(/^\+/, "");
  const candidates = [
    `/dids?include=voice_in_trunk&filter[number]=${encodeURIComponent(`+${wantedDigits}`)}`,
    `/dids?include=voice_in_trunk&filter[number]=${encodeURIComponent(wantedDigits)}`,
    `/dids?include=voice_in_trunk&page[size]=100`
  ];

  for (const path of candidates) {
    const result = await didww(path);
    const did = result.data?.find((item) => {
      const values = [
        item.attributes?.number,
        item.attributes?.did,
        item.attributes?.did_number,
        item.attributes?.phone_number,
        item.attributes?.friendly_name,
        item.attributes?.description
      ];

      return values.some((value) => normalizePhone(value).replace(/^\+/, "") === wantedDigits);
    }) || (result.data?.length === 1 ? result.data[0] : null);

    if (did) return did;
  }

  throw new Error(`DID non trovato in DIDWW: ${didNumber}`);
}

async function findExistingTrunk() {
  const result = await didww("/voice_in_trunks?filter[name]=Expocar%20Marco%20OpenAI");
  return result.data?.find((item) => item.attributes?.name === "Expocar Marco OpenAI");
}

async function createTrunk() {
  assert(projectId, "OPENAI_PROJECT_ID mancante");

  const payload = {
    data: {
      type: "voice_in_trunks",
      attributes: {
        name: "Expocar Marco OpenAI",
        description: "Inbound SIP DIDWW verso OpenAI Realtime per Expocar",
        capacity_limit: 1,
        priority: 1,
        weight: 1,
        ringing_timeout: 30,
        cli_format: "e164",
        cli_prefix: "+",
        configuration: {
          type: "sip_configurations",
          attributes: {
            username: projectId,
            host: "sip.api.openai.com",
            port: 5061,
            transport_protocol_id: 3,
            auth_enabled: false,
            resolve_ruri: true,
            force_symmetric_rtp: false,
            symmetric_rtp_ignore_rtcp: false,
            rtp_ping: false,
            rtp_timeout: 30,
            max_transfers: 0,
            max_30x_redirects: 0,
            sst_enabled: false,
            sst_accept_501: true
          }
        }
      }
    }
  };

  return didww("/voice_in_trunks", {
    method: "POST",
    body: JSON.stringify(payload)
  }).then((result) => result.data);
}

async function assignDidToTrunk(did, trunk) {
  const payload = {
    data: {
      type: "dids",
      id: did.id,
      relationships: {
        voice_in_trunk: {
          data: {
            type: "voice_in_trunks",
            id: trunk.id
          }
        }
      }
    }
  };

  return didww(`/dids/${did.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

const trunk = await findExistingTrunk() || await createTrunk();

let did;
let assigned = false;
let pendingReason = "";

try {
  did = await findDid();
  await assignDidToTrunk(did, trunk);
  assigned = true;
} catch (error) {
  if (!String(error.message || "").includes("DID non trovato")) {
    throw error;
  }
  pendingReason = error.message;
}

console.log(JSON.stringify({
  ok: true,
  assigned,
  pendingReason,
  did: did ? {
    id: did.id,
    number: did.attributes?.number || did.attributes?.did || didNumber
  } : {
    number: didNumber,
    status: "pending_review_or_not_visible"
  },
  trunk: {
    id: trunk.id,
    name: trunk.attributes?.name || "Expocar Marco OpenAI"
  },
  sipUri: `sip:${projectId}@sip.api.openai.com;transport=tls`
}, null, 2));
