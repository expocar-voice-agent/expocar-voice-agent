import { notifySeller } from "./whatsapp.js";
import { logEvent } from "./logger.js";

const recentAlerts = new Map();
const ALERT_THROTTLE_MS = 5 * 60 * 1000;

function compact(value, maxLength = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function fingerprint(type, payload) {
  return `${type}:${payload?.message || payload?.error || payload?.code || ""}`;
}

export async function alertSeller(type, payload = {}) {
  const key = fingerprint(type, payload);
  const now = Date.now();
  const last = recentAlerts.get(key) || 0;
  if (now - last < ALERT_THROTTLE_MS) {
    logEvent("seller_alert_throttled", { alertType: type });
    return { skipped: true, throttled: true };
  }
  recentAlerts.set(key, now);

  const body = [
    "Errore sistema Expocar",
    `Tipo: ${type}`,
    payload.message ? `Messaggio: ${compact(payload.message)}` : "",
    payload.error ? `Errore: ${compact(payload.error)}` : "",
    payload.code ? `Codice: ${payload.code}` : "",
    payload.path ? `Percorso: ${payload.path}` : "",
    payload.callSid ? `Call SID: ${payload.callSid}` : "",
    payload.from ? `Da: ${payload.from}` : "",
    payload.to ? `A: ${payload.to}` : "",
    payload.details ? `Dettagli: ${compact(JSON.stringify(payload.details))}` : "",
    `Ora: ${new Date().toISOString()}`
  ].filter(Boolean).join("\n");

  try {
    const message = await notifySeller({ body });
    logEvent("seller_alert_sent", {
      alertType: type,
      sid: message.sid || null,
      skipped: Boolean(message.skipped)
    });
    return message;
  } catch (error) {
    logEvent("seller_alert_failed", {
      alertType: type,
      error: error.message
    });
    return { skipped: true, error: error.message };
  }
}
