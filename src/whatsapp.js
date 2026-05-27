import twilio from "twilio";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

function getClient() {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  return twilio(config.twilio.accountSid, config.twilio.authToken);
}

export function normalizeWhatsappNumber(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (trimmed.startsWith("whatsapp:+")) return trimmed.replace(/\s+/g, "");

  let number = trimmed.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  if (number.startsWith("00")) number = `+${number.slice(2)}`;
  if (!number.startsWith("+") && number.startsWith("3")) number = `+39${number}`;
  if (!number.startsWith("+")) return "";
  return `whatsapp:${number}`;
}

export async function sendAppointmentWhatsapp({ to, name, startTime }) {
  const client = getClient();
  const normalizedTo = normalizeWhatsappNumber(to);
  if (!client || !config.twilio.whatsappFrom || !normalizedTo) {
    logEvent("whatsapp_customer_skipped", {
      hasClient: Boolean(client),
      hasFrom: Boolean(config.twilio.whatsappFrom),
      hasTo: Boolean(normalizedTo)
    });
    return { skipped: true };
  }

  const formattedDate = new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(startTime));

  const body = `Ciao ${name || ""}, ti confermiamo l'appuntamento presso Expocar per ${formattedDate}.\n\nPosizione sede:\n${config.business.locationUrl}\n\nA presto!\nExpocar`;

  const message = await client.messages.create({
    from: config.twilio.whatsappFrom,
    to: normalizedTo,
    body
  });
  logEvent("whatsapp_customer_sent", { to: normalizedTo, sid: message.sid });
  return message;
}

export async function notifySeller({ body }) {
  const client = getClient();
  const to = normalizeWhatsappNumber(config.twilio.sellerWhatsappTo);
  if (!client || !config.twilio.whatsappFrom || !to) {
    logEvent("whatsapp_seller_skipped", {
      hasClient: Boolean(client),
      hasFrom: Boolean(config.twilio.whatsappFrom),
      hasTo: Boolean(to)
    });
    return { skipped: true };
  }

  const message = await client.messages.create({
    from: config.twilio.whatsappFrom,
    to,
    body
  });
  logEvent("whatsapp_seller_sent", { to, sid: message.sid });
  return message;
}
