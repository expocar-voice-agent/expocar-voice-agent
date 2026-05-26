import twilio from "twilio";
import { config } from "./config.js";

function getClient() {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  return twilio(config.twilio.accountSid, config.twilio.authToken);
}

export async function sendAppointmentWhatsapp({ to, name, startTime }) {
  const client = getClient();
  if (!client || !config.twilio.whatsappFrom || !to) return { skipped: true };

  const formattedDate = new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(startTime));

  const body = `Ciao ${name || ""}, ti confermiamo l'appuntamento presso Expocar per ${formattedDate}.\n\nPosizione sede:\n${config.business.locationUrl}\n\nA presto!\nExpocar`;

  return client.messages.create({
    from: config.twilio.whatsappFrom,
    to,
    body
  });
}

export async function notifySeller({ body }) {
  const client = getClient();
  if (!client || !config.twilio.whatsappFrom || !config.twilio.sellerWhatsappTo) return { skipped: true };

  return client.messages.create({
    from: config.twilio.whatsappFrom,
    to: config.twilio.sellerWhatsappTo,
    body
  });
}
