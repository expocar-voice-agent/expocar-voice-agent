import { searchInventory } from "./inventory.js";
import { checkAppointmentSlot, createAppointment, getAvailableSlots } from "./calendar.js";
import { saveLead } from "./leads.js";
import { notifySeller, normalizeWhatsappNumber, sendAppointmentWhatsapp } from "./whatsapp.js";

function formatRomeDate(value) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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
          description: "Orario preciso richiesto dal cliente in formato ISO, per esempio domani alle 18."
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
        startTime: { type: "string", description: "Orario in formato ISO." },
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

export async function runTool(name, args) {
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
        const requestedSlot = await checkAppointmentSlot({ startTime: args.requestedStartTime });
        return { requestedSlot, calendarAvailable: true };
      }
      const slots = await getAvailableSlots(args);
      return { slots, calendarAvailable: true };
    } catch (error) {
      saveLead({
        type: "calendar_unavailable",
        requestedDate: args.preferredDate,
        error: error.message
      });
      return {
        slots: [],
        calendarAvailable: false,
        message: "Calendario non disponibile. Raccogli la preferenza del cliente e avvisa che un consulente confermera l'appuntamento."
      };
    }
  }

  if (name === "crea_appuntamento") {
    const appointment = await createAppointment(args);
    const customerWhatsappTo = normalizeWhatsappNumber(args.whatsappTo || args.phone);
    saveLead({
      type: "appointment",
      name: args.name,
      phone: args.phone,
      whatsappTo: customerWhatsappTo,
      interest: args.interest,
      startTime: args.startTime,
      notes: args.notes,
      appointment
    });
    try {
      await sendAppointmentWhatsapp({
        to: customerWhatsappTo,
        name: args.name,
        startTime: args.startTime
      });
    } catch (error) {
      saveLead({
        type: "whatsapp_customer_failed",
        phone: args.phone,
        whatsappTo: customerWhatsappTo,
        error: error.message
      });
    }
    try {
      await notifySeller({
        body: [
          "Nuovo appuntamento Expocar",
          `Cliente: ${args.name}`,
          `Telefono: ${args.phone}`,
          `WhatsApp cliente: ${customerWhatsappTo || "non disponibile"}`,
          `Interesse: ${args.interest}`,
          `Orario: ${formatRomeDate(args.startTime)}`,
          args.notes ? `Note/richieste: ${args.notes}` : "",
          appointment.htmlLink ? `Calendario: ${appointment.htmlLink}` : ""
        ].filter(Boolean).join("\n")
      });
    } catch (error) {
      saveLead({
        type: "whatsapp_seller_failed",
        phone: args.phone,
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
