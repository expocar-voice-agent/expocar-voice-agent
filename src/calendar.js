import { google } from "googleapis";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

function getCalendarClient() {
  let auth;

  if (config.google.authMode === "service_account") {
    const credentials = JSON.parse(config.google.serviceAccountJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"]
    });
  } else {
    auth = new google.auth.OAuth2(
      config.google.oauthClientId,
      config.google.oauthClientSecret
    );
    auth.setCredentials({ refresh_token: config.google.oauthRefreshToken });
  }

  return google.calendar({ version: "v3", auth });
}

function formatDateInRome(date) {
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

function isWeekday(date) {
  const weekday = getRomeParts(date).weekday;
  return !["Sat", "Sun"].includes(weekday);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function slotOverlapsBusy(start, end, busy) {
  return busy.some((window) => {
    const busyStart = new Date(window.start);
    const busyEnd = new Date(window.end);
    return start < busyEnd && end > busyStart;
  });
}

function buildCandidateSlots(fromDate, days = 14) {
  const slots = [];
  const minStart = addMinutes(new Date(), config.business.minNoticeHours * 60);

  for (let day = 0; day < days; day += 1) {
    const base = new Date(fromDate);
    base.setDate(base.getDate() + day);
    const yyyyMmDd = formatDateInRome(base);

    for (let hour = config.business.openHour; hour < config.business.closeHour; hour += 1) {
      const start = dateFromRomeWallTime(yyyyMmDd, hour);
      const end = addMinutes(start, config.business.durationMinutes);
      const endParts = getRomeParts(end);
      if (Number(endParts.hour) > config.business.closeHour) continue;
      if (start < minStart) continue;
      if (!isWeekday(start)) continue;
      slots.push({ start, end });
    }
  }

  return slots;
}

export async function getAvailableSlots({ preferredDate, days = 14 } = {}) {
  const calendar = getCalendarClient();
  const startSearch = preferredDate ? new Date(preferredDate) : new Date();
  const candidates = buildCandidateSlots(startSearch, days);
  if (!candidates.length) return [];

  const timeMin = candidates[0].start.toISOString();
  const timeMax = candidates[candidates.length - 1].end.toISOString();

  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: config.business.timezone,
      items: [{ id: config.google.calendarId }]
    }
  });

  const busy = freebusy.data.calendars?.[config.google.calendarId]?.busy || [];

  return candidates
    .filter((slot) => !slotOverlapsBusy(slot.start, slot.end, busy))
    .slice(0, 3)
    .map((slot) => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString()
    }));
}

export async function createAppointment({ name, phone, interest, startTime, notes }) {
  const calendar = getCalendarClient();
  const start = new Date(startTime);
  const end = addMinutes(start, config.business.durationMinutes);

  const event = await calendar.events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary: `Appuntamento Expocar - ${name || "Cliente"}`,
      description: [
        `Telefono: ${phone || "non indicato"}`,
        `Interesse: ${interest || "non indicato"}`,
        notes ? `Note: ${notes}` : ""
      ].filter(Boolean).join("\n"),
      start: { dateTime: start.toISOString(), timeZone: config.business.timezone },
      end: { dateTime: end.toISOString(), timeZone: config.business.timezone }
    }
  });

  const appointment = {
    id: event.data.id,
    htmlLink: event.data.htmlLink,
    start: start.toISOString(),
    end: end.toISOString()
  };
  logEvent("calendar_appointment_created", {
    id: appointment.id,
    name,
    phone,
    start: appointment.start,
    calendarId: config.google.calendarId
  });
  return appointment;
}
