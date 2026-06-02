import crypto from "node:crypto";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let rpcId = 1;

function ensureConfigured() {
  if (!config.simplybook.companyLogin || !config.simplybook.apiKey) {
    throw new Error("SimplyBook non configurato: mancano SIMPLYBOOK_COMPANY_LOGIN o SIMPLYBOOK_API_KEY.");
  }
}

function formatRomeDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.business.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getRomeParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.business.timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getTimeZoneOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.business.timezone,
    timeZoneName: "shortOffset"
  }).formatToParts(date);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value || "GMT+0";
  const match = offset.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
}

function dateFromRomeWallTime(yyyyMmDd, hour, minute = 0) {
  const [year, month, day] = yyyyMmDd.split("-").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
}

function addDays(yyyyMmDd, days) {
  const date = dateFromRomeWallTime(yyyyMmDd, 12);
  date.setUTCDate(date.getUTCDate() + days);
  return formatRomeDate(date);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function isWeekday(date) {
  const weekday = getRomeParts(date).weekday;
  return !["Sat", "Sun"].includes(weekday);
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = text ? new Date(text) : new Date();
  return formatRomeDate(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
}

function normalizeTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return "";
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] || "00"}`;
}

function appointmentParts(args = {}) {
  if (args.localDate && args.localTime) {
    return {
      date: normalizeDate(args.localDate),
      time: normalizeTime(args.localTime)
    };
  }

  const text = String(args.startTime || args.requestedStartTime || "").trim();
  const localMatch = text.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})/);
  if (localMatch) {
    return {
      date: localMatch[1],
      time: `${localMatch[2].padStart(2, "0")}:${localMatch[3]}:00`
    };
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = getRomeParts(parsed);
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:00`
    };
  }

  return { date: "", time: "" };
}

function validateBusinessWindow(date, time) {
  const [hour, minute] = String(time || "").split(":").map(Number);
  const start = dateFromRomeWallTime(date, hour, minute || 0);
  const end = addMinutes(start, config.business.durationMinutes);
  const endParts = getRomeParts(end);
  const minStart = addMinutes(new Date(), config.business.minNoticeHours * 60);

  if (!date || !time || Number.isNaN(start.getTime())) {
    return { ok: false, reason: "Orario non valido." };
  }
  if (!isWeekday(start)) {
    return { ok: false, reason: "Gli appuntamenti sono disponibili dal lunedi al venerdi." };
  }
  if (start < minStart) {
    return { ok: false, reason: `Serve un preavviso minimo di ${config.business.minNoticeHours} ore.` };
  }
  if (hour < config.business.openHour || minute !== 0) {
    return { ok: false, reason: "Gli appuntamenti partono ogni ora dalle 10:00." };
  }
  if (Number(endParts.hour) > config.business.closeHour) {
    return { ok: false, reason: "L'ultimo appuntamento utile deve terminare entro le 19:00." };
  }

  return { ok: true };
}

async function jsonRpc(url, method, params = [], headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: rpcId++
    })
  });

  if (!response.ok) {
    throw new Error(`SimplyBook HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    const error = new Error(payload.error.message || "Errore SimplyBook");
    error.code = payload.error.code;
    throw error;
  }

  return payload.result;
}

async function getToken() {
  ensureConfigured();
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  cachedToken = await jsonRpc(config.simplybook.loginUrl, "getToken", [
    config.simplybook.companyLogin,
    config.simplybook.apiKey
  ]);
  cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function publicRpc(method, params = []) {
  const token = await getToken();
  return jsonRpc(config.simplybook.apiUrl, method, params, {
    "X-Company-Login": config.simplybook.companyLogin,
    "X-Token": token
  });
}

function normalizeList(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  return Object.values(result);
}

function serviceId() {
  return Number(config.simplybook.serviceId || 2);
}

function configuredUnitId() {
  return config.simplybook.unitId ? Number(config.simplybook.unitId) : null;
}

function flattenSlots(matrix) {
  const slots = [];
  for (const [date, times] of Object.entries(matrix || {})) {
    for (const rawTime of times || []) {
      const time = normalizeTime(rawTime);
      const [hour, minute] = time.split(":").map(Number);
      const startDate = dateFromRomeWallTime(date, hour, minute || 0);
      slots.push({
        date,
        time,
        start: startDate.toISOString(),
        label: `${date} ${time.slice(0, 5)}`
      });
    }
  }
  return slots;
}

async function getAvailableUnitsForSlot(eventId, date, time) {
  const dateTime = `${date} ${time}`;
  const units = await publicRpc("getAvailableUnits", [eventId, dateTime, 1]);
  return Array.isArray(units) ? units : Object.values(units || {});
}

async function resolveUnitId(eventId, date, time) {
  const unitId = configuredUnitId();
  if (unitId) return unitId;

  const units = await getAvailableUnitsForSlot(eventId, date, time);
  const first = units[0];
  if (!first) throw new Error("Nessun consulente SimplyBook disponibile per questo orario.");
  return Number(typeof first === "object" ? first.id : first);
}

export function simplyBookConfigured() {
  return Boolean(config.simplybook.companyLogin && config.simplybook.apiKey);
}

export async function getSimplyBookServices() {
  return normalizeList(await publicRpc("getEventList", [true, true])).map((service) => ({
    id: service.id,
    name: service.name,
    duration: service.duration,
    isActive: service.is_active,
    isPublic: service.is_public
  }));
}

export async function getSimplyBookUnits() {
  return normalizeList(await publicRpc("getUnitList", [true, true])).map((unit) => ({
    id: unit.id,
    name: unit.name,
    isActive: unit.is_active,
    isVisible: unit.is_visible
  }));
}

export async function getSimplyBookSlots({ preferredDate, localDate, days = 14 } = {}) {
  const from = normalizeDate(localDate || preferredDate || new Date());
  const to = addDays(from, Math.max(0, Number(days) || 14));
  const matrix = await publicRpc("getStartTimeMatrix", [
    from,
    to,
    serviceId(),
    configuredUnitId(),
    1
  ]);

  return flattenSlots(matrix)
    .filter((slot) => validateBusinessWindow(slot.date, slot.time).ok)
    .slice(0, 3)
    .map((slot) => ({
      start: slot.start,
      date: slot.date,
      time: slot.time,
      label: slot.label
    }));
}

export async function checkSimplyBookSlot(args = {}) {
  const { date, time } = appointmentParts(args);
  const validation = validateBusinessWindow(date, time);
  if (!validation.ok) {
    return {
      available: false,
      reason: validation.reason,
      slot: { start: date && time ? dateFromRomeWallTime(date, ...time.split(":").map(Number).slice(0, 2)).toISOString() : "" }
    };
  }

  const matrix = await publicRpc("getStartTimeMatrix", [
    date,
    date,
    serviceId(),
    configuredUnitId(),
    1
  ]);
  const times = (matrix?.[date] || []).map(normalizeTime);
  const available = times.includes(time);
  return {
    available,
    reason: available ? "" : "Lo slot richiesto non risulta disponibile.",
    slot: { start: dateFromRomeWallTime(date, ...time.split(":").map(Number).slice(0, 2)).toISOString(), date, time }
  };
}

export async function createSimplyBookBooking(args = {}) {
  const { date, time } = appointmentParts(args);
  const validation = validateBusinessWindow(date, time);
  if (!validation.ok) throw new Error(validation.reason);

  const eventId = serviceId();
  const unitId = await resolveUnitId(eventId, date, time);
  const clientData = {
    name: args.name || "Cliente Expocar",
    phone: args.phone || "",
    email: args.email || config.simplybook.defaultClientEmail || ""
  };
  const additional = {
    note: [
      args.interest ? `Interesse: ${args.interest}` : "",
      args.notes ? `Note: ${args.notes}` : "",
      args.callSid ? `Call SID: ${args.callSid}` : ""
    ].filter(Boolean).join("\n")
  };

  const result = await publicRpc("book", [
    eventId,
    unitId,
    date,
    time,
    clientData,
    additional,
    1
  ]);

  if (result?.require_confirm && config.simplybook.apiSecret) {
    for (const booking of result.bookings || []) {
      const sign = crypto
        .createHash("md5")
        .update(`${booking.id}${booking.hash}${config.simplybook.apiSecret}`)
        .digest("hex");
      try {
        await publicRpc("confirmBooking", [booking.id, sign]);
      } catch (error) {
        await publicRpc("confirmBookng", [booking.id, sign]);
      }
    }
  }

  const booking = result?.bookings?.[0] || {};
  const appointment = {
    id: booking.id || result?.id || "",
    eventId,
    unitId,
    start: dateFromRomeWallTime(date, ...time.split(":").map(Number).slice(0, 2)).toISOString(),
    date,
    time,
    raw: result
  };

  logEvent("simplybook_appointment_created", {
    id: appointment.id,
    eventId,
    unitId,
    name: args.name,
    phone: args.phone,
    start: appointment.start
  });

  return appointment;
}
