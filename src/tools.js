import { searchInventory } from "./inventory.js";
import { checkAppointmentSlot, createAppointment, getAvailableSlots } from "./calendar.js";
import { saveLead } from "./leads.js";
import { notifySeller, normalizeWhatsappNumber, sendAppointmentWhatsapp } from "./whatsapp.js";
import twilio from "twilio";
import { config } from "./config.js";

function formatRomeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "orario da verificare";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function buildImportSummary(args) {
  return [
    "Richiesta importazione auto Expocar",
    `Cliente: ${args.name || "non indicato"}`,
    `Telefono: ${args.phone || "non indicato"}`,
    args.request ? `Richiesta: ${args.request}` : "",
    args.brand || args.model ? `Auto cercata: ${[args.brand, args.model].filter(Boolean).join(" ")}` : "",
    args.budget ? `Budget: ${args.budget}` : "",
    args.fuel ? `Alimentazione: ${args.fuel}` : "",
    args.gearbox ? `Cambio: ${args.gearbox}` : "",
    args.minYear ? `Anno minimo: ${args.minYear}` : "",
    args.maxMileage ? `Km massimi: ${args.maxMileage}` : "",
    args.color ? `Colore/preferenze: ${args.color}` : "",
    args.tradeIn ? `Permuta: ${args.tradeIn}` : "",
    args.payment ? `Pagamento: ${args.payment}` : "",
    args.financing ? `Finanziamento: ${args.financing}` : "",
    args.notes ? `Note: ${args.notes}` : ""
  ].filter(Boolean).join("\n");
}

function getTwilioClient() {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  return twilio(config.twilio.accountSid, config.twilio.authToken);
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let number = text.replace(/^whatsapp:/, "").replace(/[^\d+]/g, "");
  if (number.startsWith("00")) number = `+${number.slice(2)}`;
  if (!number.startsWith("+") && number.startsWith("3")) number = `+39${number}`;
  return number.startsWith("+") ? number : "";
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    })
  ]);
}

async function transferActiveCall({ callSid, reason }) {
  const client = getTwilioClient();
  const to = normalizePhone(config.twilio.humanTransferTo);
  if (!client || !callSid || !to) {
    return {
      ok: false,
      transferred: false,
      phone: to || config.twilio.humanTransferTo,
      message: "Trasferimento non disponibile. Comunica il numero diretto e WhatsApp."
    };
  }

  const response = new twilio.twiml.VoiceResponse();
  response.say({
    language: "it-IT",
    voice: "Polly.Giorgio"
  }, "La metto subito in contatto con un consulente Expocar. Se la linea dovesse cadere, puo chiamare o scrivere su WhatsApp al numero 371 193 8885.");
  response.dial({
    callerId: config.twilio.fromNumber || undefined,
    timeout: 25
  }, to);

  await client.calls(callSid).update({ twiml: response.toString() });
  saveLead({
    type: "call_transfer",
    callSid,
    to,
    reason
  });
  return {
    ok: true,
    transferred: true,
    phone: to,
    message: "Trasferimento avviato verso il consulente."
  };
}

export const realtimeTools = [
  {
    type: "function",
    name: "cerca_auto",
    description: "Cerca auto disponibili nel parco Expocar tramite MultiGestionale. Da usare sempre prima di dire che un'auto non e disponibile.",
    parameters: {
      type: "object",
      properties: {
        brand: { type: "string" },
        model: { type: "string" },
        fuel: { type: "string" },
        gearbox: { type: "string" },
        maxBudget: { type: "number" },
        maxMileage: { type: "number" },
        minYear: { type: "number" },
        keyword: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "controlla_disponibilita",
    description: "Verifica uno slot preciso o trova fino a 3 slot disponibili per appuntamenti in sede.",
    parameters: {
      type: "object",
      properties: {
        requestedStartTime: {
          type: "string",
          description: "Orario preciso richiesto dal cliente. Interpreta sempre come orario locale italiano, non UTC."
        },
        localDate: {
          type: "string",
          description: "Data locale dell'appuntamento in Italia, formato YYYY-MM-DD."
        },
        localTime: {
          type: "string",
          description: "Ora locale dell'appuntamento in Italia, formato HH:mm, per esempio 11:00."
        },
        preferredDate: {
          type: "string",
          description: "Data preferita in formato ISO, se il cliente ne indica una."
        }
      }
    }
  },
  {
    type: "function",
    name: "crea_appuntamento",
    description: "Crea un appuntamento reale su Google Calendar, invia WhatsApp di conferma al cliente e invia riepilogo WhatsApp al venditore.",
    parameters: {
      type: "object",
      required: ["name", "phone", "interest", "startTime"],
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        whatsappTo: { type: "string", description: "Numero WhatsApp cliente in formato whatsapp:+39..." },
        interest: { type: "string" },
        startTime: { type: "string", description: "Orario richiesto dal cliente. Interpreta sempre come orario locale italiano, non UTC." },
        localDate: { type: "string", description: "Data locale dell'appuntamento in Italia, formato YYYY-MM-DD." },
        localTime: { type: "string", description: "Ora locale dell'appuntamento in Italia, formato HH:mm, per esempio 11:00." },
        notes: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "registra_richiesta_importazione",
    description: "Registra una richiesta di importazione auto dall'Europa e invia subito il riepilogo WhatsApp al venditore.",
    parameters: {
      type: "object",
      required: ["summary"],
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        request: { type: "string" },
        summary: { type: "string", description: "Riassunto chiaro della richiesta cliente." },
        brand: { type: "string" },
        model: { type: "string" },
        budget: { type: "string" },
        fuel: { type: "string" },
        gearbox: { type: "string" },
        minYear: { type: "number" },
        maxMileage: { type: "number" },
        color: { type: "string" },
        tradeIn: { type: "string" },
        payment: { type: "string" },
        financing: { type: "string" },
        notes: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "trasferisci_chiamata",
    description: "Trasferisce la telefonata a un consulente umano solo quando il cliente chiede di parlare subito/adesso con una persona. Non usare per fissare appuntamenti con consulente.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo del trasferimento richiesto dal cliente." }
      }
    }
  },
  {
    type: "function",
    name: "avvisa_venditore",
    description: "Invia una notifica WhatsApp al venditore per escalation o lead caldo.",
    parameters: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    }
  }
];

export async function runTool(name, args, context = {}) {
  if (name === "cerca_auto") {
    const results = await searchInventory(args);
    return {
      results,
      count: results.length,
      message: results.length
        ? "Auto trovate nello stock Expocar. Comunica al cliente i risultati principali."
        : "Nessun risultato trovato con questi filtri. Non dire che e impossibile: proponi importazione su misura o chiedi una verifica a un consulente."
    };
  }

  if (name === "controlla_disponibilita") {
    try {
      if (args.requestedStartTime) {
        const requestedSlot = await withTimeout(
          checkAppointmentSlot({
            startTime: args.requestedStartTime,
            localDate: args.localDate,
            localTime: args.localTime
          }),
          2500,
          "Google Calendar non ha risposto in tempo."
        );
        return { requestedSlot, calendarAvailable: true };
      }
      const slots = await withTimeout(
        getAvailableSlots(args),
        2500,
        "Google Calendar non ha risposto in tempo."
      );
      return { slots, calendarAvailable: true };
    } catch (error) {
      saveLead({
        type: "calendar_unavailable",
        requestedDate: args.preferredDate,
        requestedStartTime: args.requestedStartTime,
        localDate: args.localDate,
        localTime: args.localTime,
        error: error.message
      });
      notifySeller({
        body: [
          "Calendario Expocar lento/non disponibile",
          "Marco deve raccogliere la preferenza e far confermare da un consulente.",
          args.localDate || args.localTime ? `Richiesta: ${[args.localDate, args.localTime].filter(Boolean).join(" ")}` : "",
          args.requestedStartTime ? `Orario richiesto: ${args.requestedStartTime}` : "",
          `Errore: ${error.message}`
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        slots: [],
        calendarAvailable: false,
        message: "Calendario momentaneamente lento. Non restare in silenzio: raccogli nome, telefono, giorno e ora preferiti; spiega che un consulente confermera subito l'appuntamento."
      };
    }
  }

  if (name === "crea_appuntamento") {
    let appointment;
    try {
      appointment = await withTimeout(
        createAppointment(args),
        3500,
        "Google Calendar non ha creato l'appuntamento in tempo."
      );
    } catch (error) {
      const customerWhatsappTo = normalizeWhatsappNumber(args.whatsappTo || args.phone);
      saveLead({
        type: "appointment_pending_confirmation",
        name: args.name,
        phone: args.phone,
        whatsappTo: customerWhatsappTo,
        interest: args.interest,
        startTime: args.startTime,
        localDate: args.localDate,
        localTime: args.localTime,
        notes: args.notes,
        error: error.message
      });
      notifySeller({
        body: [
          "Appuntamento da confermare manualmente",
          `Cliente: ${args.name || "non indicato"}`,
          `Telefono: ${args.phone || "non indicato"}`,
          `WhatsApp cliente: ${customerWhatsappTo || "non disponibile"}`,
          `Interesse: ${args.interest || "non indicato"}`,
          args.localDate || args.localTime ? `Richiesta: ${[args.localDate, args.localTime].filter(Boolean).join(" ")}` : "",
          args.startTime ? `Orario: ${args.startTime}` : "",
          args.notes ? `Note: ${args.notes}` : "",
          `Errore: ${error.message}`
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        appointment: null,
        pendingConfirmation: true,
        customerWhatsappSentTo: customerWhatsappTo || null,
        message: "Calendario momentaneamente lento. Non confermare come definitivo: rassicura il cliente, prendi nota e di' che un consulente confermera l'appuntamento a breve."
      };
    }
    const appointmentStart = appointment.start || args.startTime;
    const customerPhone = args.phone || context.from;
    const customerWhatsappTo = normalizeWhatsappNumber(args.whatsappTo || customerPhone);
    saveLead({
      type: "appointment",
      name: args.name,
      phone: customerPhone,
      whatsappTo: customerWhatsappTo,
      interest: args.interest,
      startTime: appointmentStart,
      notes: args.notes,
      appointment
    });
    try {
      await sendAppointmentWhatsapp({
        to: customerWhatsappTo,
        name: args.name,
        startTime: appointmentStart
      });
    } catch (error) {
      saveLead({
        type: "whatsapp_customer_failed",
        phone: customerPhone,
        whatsappTo: customerWhatsappTo,
        error: error.message
      });
    }
    try {
      await notifySeller({
        body: [
          "Nuovo appuntamento Expocar",
          `Cliente: ${args.name}`,
          `Telefono: ${customerPhone}`,
          `WhatsApp cliente: ${customerWhatsappTo || "non disponibile"}`,
          `Interesse: ${args.interest}`,
          `Orario: ${formatRomeDate(appointmentStart)}`,
          args.notes ? `Note/richieste: ${args.notes}` : "",
          appointment.htmlLink ? `Calendario: ${appointment.htmlLink}` : ""
        ].filter(Boolean).join("\n")
      });
    } catch (error) {
      saveLead({
        type: "whatsapp_seller_failed",
        phone: customerPhone,
        error: error.message
      });
    }
    return {
      appointment,
      customerWhatsappSentTo: customerWhatsappTo || null,
      sellerNotified: true
    };
  }

  if (name === "registra_richiesta_importazione") {
    const summary = args.summary || buildImportSummary(args);
    const lead = saveLead({
      type: "import_request",
      ...args,
      summary
    });
    try {
      await notifySeller({ body: buildImportSummary({ ...args, request: args.request || summary }) });
    } catch (error) {
      saveLead({
        type: "whatsapp_seller_failed",
        summary,
        error: error.message
      });
    }
    return { ok: true, lead };
  }

  if (name === "trasferisci_chiamata") {
    return transferActiveCall({
      callSid: context.callSid,
      reason: args.reason
    });
  }

  if (name === "avvisa_venditore") {
    saveLead({
      type: "seller_alert",
      summary: args.summary
    });
    try {
      await notifySeller({ body: `Lead Expocar\n${args.summary}` });
    } catch (error) {
      saveLead({
        type: "whatsapp_seller_failed",
        summary: args.summary,
        error: error.message
      });
    }
    return { ok: true };
  }

  throw new Error(`Unknown tool: ${name}`);
}
