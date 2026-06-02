import { config } from "./config.js";
import { logEvent } from "./logger.js";

export function elevenLabsConfigured() {
  return Boolean(config.elevenlabs.enabled && config.elevenlabs.apiKey && config.elevenlabs.voiceId);
}

async function requestElevenLabsStream(text) {
  const input = String(text || "").trim();
  if (!elevenLabsConfigured() || !input) return null;

  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabs.voiceId)}/stream`);
  url.searchParams.set("output_format", config.elevenlabs.outputFormat);
  url.searchParams.set("optimize_streaming_latency", String(config.elevenlabs.optimizeLatency));

  return fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenlabs.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
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
  const input = String(text || "").trim();
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
  const input = String(text || "").trim();
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
