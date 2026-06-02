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

export function prepareTextForTelephoneTts(text) {
  let output = String(text || "")
    .replace(/\s+/g, " ")
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
    .replace(/\bGLA\b/gi, "G L A")
    .replace(/\bGLC\b/gi, "G L C")
    .replace(/\bGLE\b/gi, "G L E")
    .replace(/\bAMG\b/gi, "A M G")
    .replace(/\bGT\b/gi, "G T");

  output = output.replace(/\b(?:euro\s*)?(\d{5,6})\s*(?:euro|€)\b/gi, (_match, amount) => {
    const clean = compactNumber(amount);
    const thousands = clean.slice(0, -3);
    const rest = clean.slice(-3).replace(/^0+/, "");
    return `${thousands} mila${rest ? ` ${rest}` : ""} euro`.replace(/\s+/g, " ");
  });

  output = output.replace(/\b(\d{5,6})\s*(?:km|chilometri)\b/gi, (_match, km) => {
    const clean = compactNumber(km);
    const thousands = clean.slice(0, -3);
    const rest = clean.slice(-3).replace(/^0+/, "");
    return `${thousands} mila${rest ? ` ${rest}` : ""} chilometri`.replace(/\s+/g, " ");
  });

  output = output.replace(/\b(\+?39)?\s*(3\d{2})\s*(\d{3})\s*(\d{4})\b/g, (_match, prefix, a, b, c) => {
    const spokenPrefix = prefix ? "piu trentanove, " : "";
    return ` ${spokenPrefix}${spellDigits(a)}, ${spellDigits(b)}, ${spellDigits(c)} `;
  });

  output = output.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, "$3/$2/$1");
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
