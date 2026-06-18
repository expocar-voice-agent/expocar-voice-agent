import { config } from "./config.js";
import { logEvent } from "./logger.js";

export function elevenLabsConfigured() {
  return Boolean(config.elevenlabs.enabled && config.elevenlabs.apiKey && config.elevenlabs.voiceId);
}

function spellDigits(value) {
  const words = {
    0: "zero",
    1: "uno",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove"
  };
  return String(value).split("").map((digit) => words[digit] || digit).join(" ");
}

function compactNumber(value) {
  return String(value || "").replace(/[.\s]/g, "");
}

function italianHour(value) {
  const words = {
    0: "zero",
    1: "una",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove",
    10: "dieci",
    11: "undici",
    12: "dodici",
    13: "tredici",
    14: "quattordici",
    15: "quindici",
    16: "sedici",
    17: "diciassette",
    18: "diciotto",
    19: "diciannove",
    20: "venti"
  };
  return words[Number(value)] || String(value);
}

function smallItalianNumber(value) {
  const number = Number(value);
  const words = {
    0: "zero",
    1: "uno",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove",
    10: "dieci",
    11: "undici",
    12: "dodici",
    13: "tredici",
    14: "quattordici",
    15: "quindici",
    16: "sedici",
    17: "diciassette",
    18: "diciotto",
    19: "diciannove",
    20: "venti",
    21: "ventuno",
    22: "ventidue",
    23: "ventitre",
    24: "ventiquattro",
    25: "venticinque",
    26: "ventisei",
    27: "ventisette",
    28: "ventotto",
    29: "ventinove",
    30: "trenta",
    100: "cento"
  };
  if (words[number]) return words[number];
  if (number > 30 && number < 100) {
    const tensWords = {
      3: "trenta",
      4: "quaranta",
      5: "cinquanta",
      6: "sessanta",
      7: "settanta",
      8: "ottanta",
      9: "novanta"
    };
    const tens = Math.floor(number / 10);
    const unit = number % 10;
    return unit ? `${tensWords[tens]}${words[unit]}` : tensWords[tens];
  }
  if (number > 100 && number < 200) {
    const rest = number - 100;
    return rest ? `cento ${smallItalianNumber(rest)}` : "cento";
  }
  if (number >= 200 && number < 1000) {
    const hundredsWords = {
      2: "duecento",
      3: "trecento",
      4: "quattrocento",
      5: "cinquecento",
      6: "seicento",
      7: "settecento",
      8: "ottocento",
      9: "novecento"
    };
    const hundreds = Math.floor(number / 100);
    const rest = number % 100;
    return rest ? `${hundredsWords[hundreds]} ${smallItalianNumber(rest)}` : hundredsWords[hundreds];
  }
  return String(number);
}

function spokenTime(hour, minute = "00") {
  if (minute === "00") return `alle ore ${italianHour(hour)}`;
  if (minute === "30") return `alle ore ${italianHour(hour)} e trenta`;
  return `alle ore ${italianHour(hour)} e ${spellDigits(minute)}`;
}

function roundedKmText(value) {
  const km = Number(compactNumber(value));
  if (!Number.isFinite(km) || km <= 0) return `${value} chilometri`;
  const rounded = km >= 100000
    ? Math.max(1, Math.round(km / 10000) * 10)
    : km >= 50000
      ? Math.max(1, Math.round(km / 5000) * 5)
      : Math.max(1, Math.floor(km / 1000));
  if (rounded === 100) return "circa centomila chilometri";
  return `circa ${smallItalianNumber(rounded)} mila chilometri`;
}

function spokenEuroAmount(value) {
  const amount = Number(compactNumber(value));
  if (!Number.isFinite(amount) || amount <= 0) return `${value} euro`;
  const thousands = Math.floor(amount / 1000);
  const rest = amount % 1000;
  if (!thousands) return `${smallItalianNumber(rest)} euro`;
  return `${smallItalianNumber(thousands)} mila${rest ? ` ${smallItalianNumber(rest)}` : ""} euro`;
}

export function prepareTextForTelephoneTts(text) {
  let output = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\bcoches\b/gi, "auto")
    .replace(/\bcoche\b/gi, "auto")
    .replace(/\bdisponibles\b/gi, "disponibili")
    .replace(/\bprecio\b/gi, "prezzo")
    .replace(/\bkilometraje\b/gi, "chilometraggio")
    .replace(/\bkilometros\b/gi, "chilometri")
    .replace(/\bgracias\b/gi, "grazie")
    .replace(/\bvale\b/gi, "va bene")
    .replace(/\bperfecto\b/gi, "va bene")
    .replace(/\blunedi\b/gi, "lunedì")
    .replace(/\bmartedi\b/gi, "martedì")
    .replace(/\bmercoledi\b/gi, "mercoledì")
    .replace(/\bgiovedi\b/gi, "giovedì")
    .replace(/\bvenerdi\b/gi, "venerdì")
    .replace(/\bdisponibilita\b/gi, "disponibilità")
    .replace(/\bpossibilita\b/gi, "possibilità")
    .replace(/dal lunedì al venerdì/gi, "da lunedì a venerdì")
    .replace(/\bnon e disponibile\b/gi, "non è disponibile")
    .replace(/\be disponibile\b/gi, "è disponibile")
    .replace(/[€]/g, " euro ")
    .replace(/\b(\d{1,3})[.](\d{3})\b/g, "$1$2")
    .trim();

  output = output
    .replace(/\bBMW\b/gi, "B M W")
    .replace(/\bSUV\b/gi, "S U V")
    .replace(/\bTDI\b/gi, "T D I")
    .replace(/\bTFSI\b/gi, "T F S I")
    .replace(/\bS\s*tronic\b/gi, "S tronic")
    .replace(/\bquattro\b/gi, "quattro")
    .replace(/\bRS\s*Q\s*(\d)\b/gi, "R S Q $1")
    .replace(/\bQ\s*(\d)\b/gi, "Q $1")
    .replace(/\bX\s*(\d)\b/gi, "X $1")
    .replace(/\bA\s*(\d)\b/gi, "A $1")
    .replace(/\bS\s*(\d)\b/gi, "S $1")
    .replace(/\b(Ferrari|Porsche|Lamborghini|McLaren)\s+(\d{3,4})\b/gi, (_match, brand, model) => {
      const spokenModel = model === "500" ? "cinquecento" : spellDigits(model);
      return `${brand} ${spokenModel}`;
    })
    .replace(/\b(296|458|488|812|911)\b/g, (_match, model) => spellDigits(model))
    .replace(/\bGLA\b/gi, "G L A")
    .replace(/\bGLC\b/gi, "G L C")
    .replace(/\bGLE\b/gi, "G L E")
    .replace(/\bAMG\b/gi, "A M G")
    .replace(/\bGT\b/gi, "G T");

  output = output.replace(/\b(?:euro\s*)?(\d{5,6})\s*(?:euro|€)\b/gi, (_match, amount) => {
    return spokenEuroAmount(amount).replace(/\s+/g, " ");
  });

  output = output.replace(/\b(circa\s+)?(\d{5,6})\s*(?:km|chilometri)\b/gi, (_match, approx, km) => {
    const spoken = roundedKmText(km);
    return approx ? spoken : spoken;
  });

  output = output.replace(/\bcirca\s+circa\b/gi, "circa");

  output = output.replace(/\b(\+?39)?\s*(3\d{2})\s*(\d{3})\s*(\d{4})\b/g, (_match, prefix, a, b, c) => {
    const spokenPrefix = prefix ? "piu trentanove, " : "";
    return ` ${spokenPrefix}${spellDigits(a)}, ${spellDigits(b)}, ${spellDigits(c)} `;
  });

  output = output.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$3/$2/$1");
  output = output.replace(/\balle ore\s+(\d{1,2}):(\d{2})\b/gi, (_match, hour, minute) => {
    return spokenTime(hour, minute);
  });
  output = output.replace(/\balle ore\s+(\d{1,2})(?:\s+e\s+(\d{2}))?\b/gi, (_match, hour, minute) => {
    return spokenTime(hour, minute || "00");
  });
  output = output.replace(/\b(?:ore\s*)?(\d{1,2}):(\d{2})\b/gi, (_match, hour, minute) => {
    const numericHour = Number(hour);
    if (numericHour < 7 || numericHour > 22) return _match;
    return spokenTime(hour, minute);
  });
  output = output.replace(
    /(?:La metto subito in contatto con un consulente[.!?]?\s*){2,}/gi,
    "La metto subito in contatto con un consulente. "
  );
  output = output.replace(
    /(?:I'll connect you with a sales consultant now[.!?]?\s*){2,}/gi,
    "I'll connect you with a sales consultant now. "
  );
  return output.replace(/\s+/g, " ").trim();
}

async function requestElevenLabsStream(text) {
  const input = prepareTextForTelephoneTts(text);
  if (!elevenLabsConfigured() || !input) return null;

  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabs.voiceId)}/stream`);
  url.searchParams.set("output_format", config.elevenlabs.outputFormat);
  url.searchParams.set("optimize_streaming_latency", String(config.elevenlabs.optimizeLatency));

  return fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenlabs.apiKey,
      "Content-Type": "application/json",
      Accept: "application/octet-stream"
    },
    body: JSON.stringify({
      text: input,
      model_id: config.elevenlabs.modelId,
      voice_settings: {
        stability: config.elevenlabs.stability,
        similarity_boost: config.elevenlabs.similarityBoost,
        style: config.elevenlabs.style,
        use_speaker_boost: config.elevenlabs.useSpeakerBoost
      }
    })
  });
}

export async function streamElevenLabsUlaw(text, onChunk) {
  const input = prepareTextForTelephoneTts(text);
  const response = await requestElevenLabsStream(input);
  if (!response) return { skipped: true, chunks: 0, bytes: 0 };

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed ${response.status}: ${body.slice(0, 300)}`);
  }

  let chunks = 0;
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    if (!buffer.length) continue;
    chunks += 1;
    bytes += buffer.length;
    await onChunk(buffer);
  }

  logEvent("elevenlabs_tts_stream_done", {
    bytes,
    chunks,
    chars: input.length,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.modelId,
    outputFormat: config.elevenlabs.outputFormat
  });
  return { skipped: false, chunks, bytes };
}

export async function synthesizeElevenLabsUlaw(text) {
  const input = prepareTextForTelephoneTts(text);
  const response = await requestElevenLabsStream(input);
  if (!response) return null;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed ${response.status}: ${body.slice(0, 300)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  logEvent("elevenlabs_tts_done", {
    bytes: audio.length,
    chars: input.length,
    voiceId: config.elevenlabs.voiceId,
    modelId: config.elevenlabs.modelId,
    outputFormat: config.elevenlabs.outputFormat
  });
  return audio;
}
