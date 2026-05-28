import { config } from "./config.js";
import { logEvent } from "./logger.js";

function compact(value, maxLength = 5000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function transcriptText(session) {
  return session.transcript
    .map((item) => `${item.speaker}: ${item.text}`)
    .join("\n");
}

function fallbackSummary(session) {
  const transcript = transcriptText(session);
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  return [
    "Riepilogo chiamata Expocar",
    `Cliente: ${session.from || "numero non disponibile"}`,
    `Durata circa: ${durationSeconds} sec`,
    "",
    "Sintesi:",
    compact(transcript || "Trascrizione non disponibile.", 1200),
    session.toolCalls.length ? `\nAzioni sistema: ${session.toolCalls.join(", ")}` : "",
    "",
    "Prossima azione consigliata: ricontattare il cliente se la richiesta richiede proposta, preventivo o conferma."
  ].filter(Boolean).join("\n");
}

export async function buildSellerCallSummary(session) {
  const transcript = transcriptText(session);
  if (!transcript) return fallbackSummary(session);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openai.summaryModel,
        input: [
          {
            role: "system",
            content: "Sei un assistente commerciale per Expocar Italia. Crea un riepilogo WhatsApp breve, utile e operativo di una telefonata. Scrivi in italiano. Non inventare dati non presenti."
          },
          {
            role: "user",
            content: [
              `Numero cliente: ${session.from || "non disponibile"}`,
              `Numero chiamato: ${session.to || "non disponibile"}`,
              `Azioni sistema: ${session.toolCalls.join(", ") || "nessuna"}`,
              "",
              "Trascrizione:",
              compact(transcript, 6000),
              "",
              "Formato richiesto:",
              "Riepilogo chiamata Expocar",
              "Cliente/numero:",
              "Richiesta principale:",
              "Dettagli utili:",
              "Auto/prodotto citato:",
              "Budget/preferenze:",
              "Appuntamento o prossima azione:",
              "Urgenza/priorita:"
            ].join("\n")
          }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI summary failed ${response.status}: ${body}`);
    }

    const data = await response.json();
    const text = data.output_text
      || data.output?.flatMap((item) => item.content || []).map((part) => part.text).filter(Boolean).join("\n")
      || "";
    return text.trim() || fallbackSummary(session);
  } catch (error) {
    logEvent("call_summary_ai_failed", {
      callSid: session.callSid,
      error: error.message
    });
    return fallbackSummary(session);
  }
}
