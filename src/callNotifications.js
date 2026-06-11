import { logEvent } from "./logger.js";
import { notifySeller } from "./whatsapp.js";

const pendingCalls = new Map();

function pendingFor(callSid) {
  const key = callSid || `unknown-${Date.now()}`;
  if (!pendingCalls.has(key)) {
    pendingCalls.set(key, {
      callSid: key,
      summaryBody: "",
      recordingBody: "",
      sent: false,
      timer: null
    });
  }
  return pendingCalls.get(key);
}

async function sendPending(callSid, reason = "ready") {
  const item = pendingCalls.get(callSid);
  if (!item || item.sent || !item.summaryBody) return null;

  clearTimeout(item.timer);
  item.sent = true;
  const body = [
    item.summaryBody,
    item.recordingBody ? "" : "",
    item.recordingBody || "Registrazione: in elaborazione, arrivera separatamente se Twilio la rende disponibile."
  ].filter((line) => line !== "").join("\n");

  try {
    const message = await notifySeller({ body });
    logEvent("call_lead_telegram_sent", { callSid, reason, combinedRecording: Boolean(item.recordingBody) });
    return message;
  } finally {
    pendingCalls.delete(callSid);
  }
}

export async function submitCallSummary({ callSid, body }) {
  const item = pendingFor(callSid);
  item.summaryBody = body;
  if (item.recordingBody) return sendPending(item.callSid, "summary_and_recording_ready");

  clearTimeout(item.timer);
  item.timer = setTimeout(() => {
    sendPending(item.callSid, "summary_timeout_waiting_recording").catch((error) => {
      logEvent("call_lead_telegram_failed", { callSid: item.callSid, error: error.message });
    });
  }, 9000);
  return { queued: true };
}

export async function submitCallRecording({ callSid, body }) {
  const item = pendingFor(callSid);
  item.recordingBody = body;
  if (item.summaryBody && !item.sent) return sendPending(item.callSid, "summary_and_recording_ready");

  clearTimeout(item.timer);
  item.timer = setTimeout(() => {
    if (!item.sent && item.recordingBody && !item.summaryBody) {
      notifySeller({ body: item.recordingBody })
        .then(() => logEvent("call_recording_telegram_sent_without_summary", { callSid: item.callSid }))
        .catch((error) => logEvent("call_recording_telegram_failed", { callSid: item.callSid, error: error.message }))
        .finally(() => pendingCalls.delete(item.callSid));
    }
  }, 20000);
  return { queued: true };
}
