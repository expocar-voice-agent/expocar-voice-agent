import { logEvent } from "./logger.js";
import { alertSeller } from "./alerts.js";

const calls = new Map();
const TERMINAL_STATUSES = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);

function nowIso() {
  return new Date().toISOString();
}

function getCall(callSid) {
  if (!callSid) return null;
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      callSid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      streamStarted: false,
      streamStopped: false,
      terminalStatusSeen: false
    });
  }
  return calls.get(callSid);
}

function remember(callSid, patch) {
  const call = getCall(callSid);
  if (!call) return null;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) call[key] = value;
  }
  call.updatedAt = nowIso();
  return call;
}

function cleanupOldCalls() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [callSid, call] of calls.entries()) {
    if (Date.parse(call.updatedAt || call.createdAt || 0) < cutoff) {
      calls.delete(callSid);
    }
  }
}

export function registerIncomingCall(payload = {}) {
  cleanupOldCalls();
  const call = remember(payload.CallSid, {
    from: payload.From,
    to: payload.To,
    direction: payload.Direction,
    initialStatus: payload.CallStatus,
    receivedVoiceWebhookAt: nowIso()
  });
  if (call) logEvent("call_lifecycle_registered", call);
  return call;
}

export function markStreamStatus(payload = {}) {
  const event = String(payload.StreamEvent || "").toLowerCase();
  const call = remember(payload.CallSid, {
    streamSid: payload.StreamSid,
    streamEvent: payload.StreamEvent,
    streamStarted: event === "stream-started" ? true : undefined,
    streamStopped: event === "stream-stopped" ? true : undefined
  });
  if (call) logEvent("call_lifecycle_stream_status", call);
  return call;
}

export async function markCallStatus(payload = {}) {
  const status = String(payload.CallStatus || "").toLowerCase();
  const call = remember(payload.CallSid, {
    status,
    duration: payload.CallDuration,
    from: payload.From || payload.Caller || undefined,
    to: payload.To || payload.Called || undefined,
    statusUpdatedAt: nowIso(),
    terminalStatusSeen: TERMINAL_STATUSES.has(status) || undefined
  });

  if (!call) return null;

  logEvent("call_lifecycle_status", call);

  if (TERMINAL_STATUSES.has(status)) {
    logEvent("call_lifecycle_ended", {
      callSid: call.callSid,
      status,
      duration: call.duration,
      from: call.from,
      to: call.to,
      streamStarted: Boolean(call.streamStarted),
      streamStopped: Boolean(call.streamStopped)
    });

    if (!call.streamStarted && ["completed", "failed"].includes(status)) {
      await alertSeller("call_ended_without_audio_stream", {
        message: "La chiamata e terminata senza avviare lo stream audio verso Marco.",
        callSid: call.callSid,
        from: call.from,
        to: call.to,
        details: { status, duration: call.duration }
      });
    }
  }

  return call;
}

export function recentCallLifecycle(limit = 20) {
  return [...calls.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}
