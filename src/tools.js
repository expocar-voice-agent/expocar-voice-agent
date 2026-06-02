import { searchInventoryDetailed } from "./inventory.js";
import { checkSimplyBookSlot, createSimplyBookBooking, getSimplyBookSlots } from "./simplybook.js";
import { saveLead } from "./leads.js";
import { notifySeller } from "./whatsapp.js";
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

function shortRomeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "orario da verificare";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function slimSlot(slot) {
  if (!slot) return null;
  return {
    start: slot.start,
    label: slot.label || shortRomeDate(slot.start)
  };
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

function hasInventoryFilters(args = {}) {
  return Boolean(
    args.brand
    || args.model
    || args.fuel
    || args.gearbox
    || args.maxBudget
    || args.maxMileage
    || args.minYear
    || args.keyword
  );
}

async function transferActiveCall({ callSid, from, reason }) {
  const client = getTwilioClient();
  const to = normalizePhone(config.twilio.humanTransferTo);
  if (!client || !callSid || !to) {
    notifySeller({
      body: [
        "Lead ExpoCar",
        `Cliente: ${from || "numero non disponibile"}`,
        "Richiesta: parlare con un consulente",
        "Trasferimento: non disponibile, comunicare numero diretto",
        reason ? `Motivo: ${reason}` : "",
        callSid ? `Call SID: ${callSid}` : ""
      ].filter(Boolean).join("\n")
    }).catch(() => {});
    return {
      ok: false,
      transferred: false,
      phone: to || config.twilio.humanTransferTo,
      message: "Trasferimento non disponibile. Comunica il numero diretto e WhatsApp."
    };
  }

  const response = new twilio.twiml.VoiceResponse();
  response.dial({
    callerId: config.twilio.fromNumber || undefined,
    timeout: 25
  }, to);

  await client.calls(callSid).update({ twiml: response.toString() });
  saveLead({
    type: "call_transfer",
    callSid,
    from,
    to,
    reason
  });
  try {
    await notifySeller({
      body: [
        "Lead ExpoCar",
        `Cliente: ${from || "numero non disponibile"}`,
        "Richiesta: parlare con un consulente",
        reason ? `Motivo: ${reason}` : "",
        `Trasferimento: avviato verso ${to}`,
        callSid ? `Call SID: ${callSid}` : "",
        "La registrazione, se disponibile, arrivera in un messaggio separato."
      ].filter(Boolean).join("\n")
    });
  } catch (error) {
    saveLead({
      type: "transfer_whatsapp_failed",
      callSid,
      from,
      error: error.message
    });
  }
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
    description: "Cerca auto nello stock Expocar.",
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
    description: "Controlla disponibilita appuntamenti.",
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
    description: "Crea appuntamento su SimplyBook.",
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
    description: "Registra lead importazione auto.",
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
    description: "Trasferisce solo se il cliente vuole parlare subito con una persona.",
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
    description: "Invia nota al venditore.",
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
    const inventory = await searchInventoryDetailed(args);
    if (!hasInventoryFilters(args)) {
      return {
        results: [],
        count: inventory.totalAvailable,
        shownCount: 0,
        totalAvailable: inventory.totalAvailable,
        message: `Totale veicoli disponibili in sede/parco: ${inventory.totalAvailable}. Rispondi solo con il totale e chiedi marca, modello o budget per filtrare.`
      };
    }

    return {
      results: inventory.results,
      count: inventory.count,
      shownCount: inventory.results.length,
      totalAvailable: inventory.totalAvailable,
      message: inventory.count
        ? `Auto trovate nello stock Expocar. Totale risultati compatibili: ${inventory.count}. Totale veicoli disponibili in sede/parco: ${inventory.totalAvailable}. Comunica al cliente solo i risultati principali mostrati.`
        : `Nessun risultato trovato con questi filtri. Totale veicoli disponibili in sede/parco: ${inventory.totalAvailable}. Non dire che e impossibile: proponi importazione su misura o chiedi una verifica a un consulente.`
    };
  }

  if (name === "controlla_disponibilita") {
    try {
      if (args.requestedStartTime) {
        const requestedSlot = await withTimeout(
          checkSimplyBookSlot({
            startTime: args.requestedStartTime,
            localDate: args.localDate,
            localTime: args.localTime
          }),
          1800,
          "SimplyBook non ha risposto in tempo."
        );
        const slot = slimSlot(requestedSlot.slot);
        return {
          bookingSystemAvailable: true,
          requestedAvailable: Boolean(requestedSlot.available),
          requestedLabel: slot?.label || "orario richiesto",
          reason: requestedSlot.reason || "",
          message: requestedSlot.available
            ? `Lo slot ${slot?.label || "richiesto"} e disponibile. Se hai nome e telefono, crea l'appuntamento.`
            : `Lo slot richiesto non e disponibile: ${requestedSlot.reason || "risulta occupato"}. Proponi una alternativa.`
        };
      }
      const slots = await withTimeout(
        getSimplyBookSlots(args),
        1800,
        "SimplyBook non ha risposto in tempo."
      );
      const alternatives = slots.slice(0, 2).map(slimSlot).filter(Boolean);
      return {
        bookingSystemAvailable: true,
        alternatives,
        firstAvailable: alternatives[0] || null,
        message: alternatives.length
          ? `Prime disponibilita: ${alternatives.map((slot) => slot.label).join(", ")}. Proponile al cliente.`
          : "Non risultano slot liberi immediati. Raccogli preferenza e fai confermare da un consulente."
      };
    } catch (error) {
      saveLead({
        type: "simplybook_unavailable",
        requestedDate: args.preferredDate,
        requestedStartTime: args.requestedStartTime,
        localDate: args.localDate,
        localTime: args.localTime,
        error: error.message
      });
      notifySeller({
        body: [
          "SimplyBook Expocar lento/non disponibile",
          "Marco deve raccogliere la preferenza e far confermare da un consulente.",
          args.localDate || args.localTime ? `Richiesta: ${[args.localDate, args.localTime].filter(Boolean).join(" ")}` : "",
          args.requestedStartTime ? `Orario richiesto: ${args.requestedStartTime}` : "",
          `Errore: ${error.message}`
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        slots: [],
        bookingSystemAvailable: false,
        message: "Sistema prenotazioni momentaneamente lento. Raccogli nome, telefono, giorno e ora preferiti; spiega in modo naturale che lo fai verificare in sede."
      };
    }
  }

  if (name === "crea_appuntamento") {
    let appointment;
    try {
      appointment = await withTimeout(
        createSimplyBookBooking({
          ...args,
          phone: args.phone || context.from,
          callSid: context.callSid
        }),
        2800,
        "SimplyBook non ha creato l'appuntamento in tempo."
      );
    } catch (error) {
      const customerPhone = args.phone || context.from;
      saveLead({
        type: "appointment_pending_confirmation",
        name: args.name,
        phone: customerPhone,
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
          `Telefono: ${customerPhone || "non indicato"}`,
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
        message: "Sistema prenotazioni momentaneamente lento. Non confermare come definitivo: prendi nota e di' che lo fai verificare in sede."
      };
    }
    const appointmentStart = appointment.start || args.startTime;
    const customerPhone = args.phone || context.from;
    saveLead({
      type: "appointment",
      name: args.name,
      phone: customerPhone,
      interest: args.interest,
      startTime: appointmentStart,
      notes: args.notes,
      appointment
    });
    try {
      await notifySeller({
        body: [
          "Nuovo appuntamento Expocar",
          `Cliente: ${args.name}`,
          `Telefono: ${customerPhone}`,
          `Interesse: ${args.interest}`,
          `Orario: ${formatRomeDate(appointmentStart)}`,
          args.notes ? `Note/richieste: ${args.notes}` : "",
          appointment.id ? `Prenotazione SimplyBook: ${appointment.id}` : ""
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
      appointment: {
        start: appointmentStart,
        label: formatRomeDate(appointmentStart)
      },
      sellerNotified: true,
      message: `Appuntamento confermato per ${formatRomeDate(appointmentStart)}. SimplyBook gestira conferma, SMS e sincronizzazione calendario.`
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
      from: context.from,
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
