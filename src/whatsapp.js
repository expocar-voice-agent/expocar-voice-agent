import twilio from "twilio";
import { config } from "./config.js";
import { logEvent } from "./logger.js";
import { notifySellerTelegram } from "./telegram.js";

function getClient() {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  return twilio(config.twilio.accountSid, config.twilio.authToken);
}

function messageStatusCallbackUrl() {
  if (!config.publicBaseUrl) return "";
  return `${config.publicBaseUrl}/twilio/message-status`;
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
  const canSendFreeform = Boolean(config.twilio.whatsappFrom);
  const canSendTemplate = Boolean(config.twilio.messagingServiceSid && config.twilio.appointmentTemplateContentSid);

  if (!client || !normalizedTo || (!canSendFreeform && !canSendTemplate)) {
    logEvent("whatsapp_customer_skipped", {
      hasClient: Boolean(client),
      hasFrom: canSendFreeform,
      hasTemplate: canSendTemplate,
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

  const payload = canSendTemplate
    ? {
        messagingServiceSid: config.twilio.messagingServiceSid,
        to: normalizedTo,
        contentSid: config.twilio.appointmentTemplateContentSid,
        contentVariables: JSON.stringify({
          1: name || "cliente",
          2: formattedDate,
          3: config.business.locationUrl
        })
      }
    : {
        from: config.twilio.whatsappFrom,
        to: normalizedTo,
        body
      };
  const statusCallback = messageStatusCallbackUrl();
  if (statusCallback) payload.statusCallback = statusCallback;

  const message = await client.messages.create(payload);
  logEvent("whatsapp_customer_sent", { to: normalizedTo, sid: message.sid });
  return message;
}

export async function sendCustomerAfterCallWhatsapp({ to }) {
  const client = getClient();
  const normalizedTo = normalizeWhatsappNumber(to);
  const canSendFreeform = Boolean(config.twilio.whatsappFrom);
  const canSendTemplate = Boolean(config.twilio.messagingServiceSid && config.twilio.customerTemplateContentSid);

  if (!client || !normalizedTo || (!canSendFreeform && !canSendTemplate)) {
    logEvent("whatsapp_customer_after_call_skipped", {
      hasClient: Boolean(client),
      hasFrom: canSendFreeform,
      hasTemplate: canSendTemplate,
      hasTo: Boolean(normalizedTo)
    });
    return { skipped: true };
  }

  const body = `🏎 ExpoCar Italia🏎

Gentile cliente,

presso la nostra concessionaria ExpoCar Italia è possibile non solo acquistare le auto già disponibili in sede e visibili su www.expocaritalia.com, ma anche ordinare il veicolo desiderato selezionando le migliori opportunità disponibili in tutta Europa.

Il nostro servizio è completamente chiavi in mano e comprende:
• ricerca personalizzata del veicolo
• importazione dall’estero
• trasporto in Italia
• immatricolazione
• tagliando completo
• garanzia 12 mesi

🔎 Come funziona

1️⃣ Il cliente fissa un appuntamento presso la nostra sede.
2️⃣ In totale trasparenza effettuiamo una ricerca mirata in base alle sue esigenze.
3️⃣ Durante la consulenza il cliente vede in diretta foto, chilometraggio, caratteristiche e provenienza del veicolo, oltre al prezzo reale di acquisto in Europa.
4️⃣ Una volta scelto il veicolo, ExpoCar Italia si occupa di tutta l’importazione e consegna il veicolo pronto su strada.

✨ Trattiamo esclusivamente auto di fascia alta e di prestigio, selezionate con attenzione per offrire ai nostri clienti massima sicurezza, trasparenza e qualità.

📍 Per informazioni o per fissare un appuntamento in sede può cliccare qui:
https://expocaritalia.simplybook.it/v2/#book/service/2`;

  const payload = canSendTemplate
    ? {
        messagingServiceSid: config.twilio.messagingServiceSid,
        to: normalizedTo,
        contentSid: config.twilio.customerTemplateContentSid
      }
    : {
        from: config.twilio.whatsappFrom,
        to: normalizedTo,
        body
      };
  const statusCallback = messageStatusCallbackUrl();
  if (statusCallback) payload.statusCallback = statusCallback;

  const message = await client.messages.create(payload);
  logEvent("whatsapp_customer_after_call_sent", { to: normalizedTo, sid: message.sid });
  return message;
}

export async function notifySeller({ body }) {
  let telegramResult = { skipped: true };
  try {
    telegramResult = await notifySellerTelegram({ body });
  } catch (error) {
    logEvent("telegram_seller_notify_failed", { error: error.message });
  }

  const client = getClient();
  const to = normalizeWhatsappNumber(config.twilio.sellerWhatsappTo);
  if (!client || !config.twilio.whatsappFrom || !to) {
    logEvent("whatsapp_seller_skipped", {
      hasClient: Boolean(client),
      hasFrom: Boolean(config.twilio.whatsappFrom),
      hasTo: Boolean(to)
    });
    return telegramResult.skipped ? { skipped: true } : telegramResult;
  }

  const text = String(body || "").trim() || "Notifica Expocar";
  const payload = {
    from: config.twilio.whatsappFrom,
    to,
    body: text
  };
  const statusCallback = messageStatusCallbackUrl();
  if (statusCallback) payload.statusCallback = statusCallback;

  const message = await client.messages.create(payload);
  logEvent("whatsapp_seller_sent", { to, sid: message.sid });
  return message;
}
