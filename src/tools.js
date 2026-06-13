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

function italianHour(value) {
  const words = {
    0: "zero",
    1: "una",
    2: "due",
    3: "tre",
    4: "quattro",
    5: "cinque",
    6: "sei",
    7: "sette",
    8: "otto",
    9: "nove",
    10: "dieci",
    11: "undici",
    12: "dodici",
    13: "tredici",
    14: "quattordici",
    15: "quindici",
    16: "sedici",
    17: "diciassette",
    18: "diciotto",
    19: "diciannove",
    20: "venti"
  };
  return words[Number(value)] || String(value);
}

function spokenRomeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "l'orario richiesto";
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const data = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = data.minute || "00";
  const hourText = minute === "30"
    ? `${italianHour(data.hour)} e trenta`
    : minute === "00"
      ? italianHour(data.hour)
      : `${italianHour(data.hour)} e ${minute.split("").join(" ")}`;
  return `${data.weekday} ${Number(data.day)} ${data.month}, alle ore ${hourText}`;
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

function parseAppointmentDate(args = {}, { fallbackToday = false } = {}) {
  const raw = args.requestedStartTime || args.startTime || args.preferredDate || args.localDate;
  if (!raw) return fallbackToday ? new Date() : null;
  const text = String(raw).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T12:00:00+02:00`)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? (fallbackToday ? new Date() : null) : date;
}

function isWeekendInRome(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.business.timezone,
    weekday: "short"
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  return ["Sat", "Sun"].includes(weekday);
}

function nextBusinessDayLabel(date) {
  const next = new Date(date);
  do {
    next.setDate(next.getDate() + 1);
  } while (isWeekendInRome(next));
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: config.business.timezone,
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(next);
}

function weekendAppointmentBlock(args = {}, { fallbackToday = false } = {}) {
  const date = parseAppointmentDate(args, { fallbackToday });
  if (!date || !isWeekendInRome(date)) return null;
  const nextDay = nextBusinessDayLabel(date);
  return {
    bookingSystemAvailable: false,
    weekendBlocked: true,
    requestedDate: args.localDate || args.preferredDate || args.requestedStartTime || args.startTime || "",
    spokenReply: `Sabato e domenica non fissiamo appuntamenti in sede e non e possibile visionare auto in giornata. Il primo giorno utile e ${nextDay}: vuole che le proponga un orario disponibile?`,
    message: "Usa spokenReply. Non controllare l'agenda per sabato o domenica e non dire che stai verificando disponibilita."
  };
}

function slimSlot(slot) {
  if (!slot) return null;
  return {
    start: slot.start,
    label: slot.label || shortRomeDate(slot.start)
  };
}

function spokenAlternatives(slots = []) {
  const labels = slots.map((slot) => slot.label).filter(Boolean);
  if (!labels.length) return "";
  const prefixes = ["prima possibilita", "seconda possibilita", "terza possibilita"];
  return labels
    .map((label, index) => `${prefixes[index] || "altra possibilita"}: ${label}`)
    .join(". ");
}

function inventorySpokenReply(inventory) {
  if (inventory.count > 2 && !inventory.hasSpecificModelFilter) {
    return `Ne vedo ${inventory.count} compatibili. Cerca un modello in particolare, oppure vuole che le dica le prime disponibili?`;
  }

  const lines = (inventory.results || [])
    .slice(0, 2)
    .map((car) => {
      const detail = car.shortDetailLine || car.spokenLine;
      return detail ? `Per ${car.intro || "questa auto"}. ${detail}.` : "";
    })
    .filter(Boolean);
  if (!lines.length) {
    return "Al momento non vedo una corrispondenza precisa in stock. Se vuole, posso raccogliere le preferenze e far verificare una ricerca su misura.";
  }
  if (inventory.fallbackFromRequestedVehicle) {
    const prefix = inventory.count === 1
      ? "Non vedo una corrispondenza precisa con quelle caratteristiche, però vedo questa auto in stock. "
      : `Non vedo una corrispondenza precisa con quelle caratteristiche, però vedo ${inventory.count} auto di quel modello in stock. `;
    const more = inventory.count > lines.length ? "Se vuole, poi posso verificare anche le altre. " : "";
    return `${prefix}${lines.join(" ")} ${more}Vuole che le approfondisca questa?`;
  }
  const prefix = inventory.count > lines.length
    ? `Ne vedo ${inventory.count} compatibili. Le dico le prime due piu vicine alla richiesta. `
    : inventory.count === 1
      ? "Ne vedo una disponibile. "
      : `Ne vedo ${inventory.count} disponibili. `;
  const more = inventory.count > lines.length ? "Se vuole, poi posso verificare anche altri modelli simili. " : "";
  return `${prefix}${lines.join(" ")} ${more}Vuole che le approfondisca una di queste?`;
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

function isBusinessOpenNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.business.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const data = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (["Sat", "Sun"].includes(data.weekday)) return false;
  const minutes = Number(data.hour) * 60 + Number(data.minute);
  return minutes >= config.business.openHour * 60 && minutes < config.business.closeHour * 60;
}

function conversationLanguage(args = {}) {
  const value = String(args.language || args.customerLanguage || "").toLowerCase();
  if (value.startsWith("en") || value.includes("english") || value.includes("inglese") || value.includes("non-italian")) {
    return "en";
  }
  return "it";
}

function transferReply(args = {}) {
  return conversationLanguage(args) === "en"
    ? "I'll connect you with a sales consultant now."
    : "La metto subito in contatto con un consulente.";
}

function transferUnavailableReply(args = {}) {
  return conversationLanguage(args) === "en"
    ? "I can't transfer the call right now. I can take your request and have a consultant call you back."
    : "Al momento non riesco a trasferire la chiamata. Intanto posso annotare la richiesta e farla richiamare.";
}

function transferOutsideHoursReply(args = {}) {
  return conversationLanguage(args) === "en"
    ? "Our consultants are available Monday to Friday, from ten to seven. I can take your request and have you called back."
    : "In questo momento i consulenti non sono disponibili al trasferimento diretto. Siamo operativi dal lunedi al venerdi, dalle dieci alle diciannove. Intanto, se vuole, raccolgo io la richiesta.";
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

function hasSpecificModelFilter(args = {}) {
  return Boolean(
    args.model
    || args.keyword
    || args.fuel
    || args.gearbox
    || args.maxBudget
    || args.maxMileage
    || args.minYear
  );
}

export async function transferActiveCall({ callSid, from, reason }) {
  const client = getTwilioClient();
  const to = normalizePhone(config.twilio.humanTransferTo);
  if (!isBusinessOpenNow()) {
    notifySeller({
      body: [
        "Lead ExpoCar",
        `Cliente: ${from || "numero non disponibile"}`,
        "Richiesta: parlare con un consulente fuori orario",
        reason ? `Motivo: ${reason}` : "",
        "Trasferimento: non effettuato, fuori orario lavorativo",
        "Azione: ricontattare il cliente appena possibile"
      ].filter(Boolean).join("\n")
    }).catch(() => {});
    return {
      ok: true,
      transferred: false,
      outsideBusinessHours: true,
      phone: to || config.twilio.humanTransferTo,
      spokenReply: "In questo momento i consulenti non sono disponibili al trasferimento diretto. Siamo operativi dal lunedi al venerdi, dalle dieci alle diciannove. Puo scriverci anche su WhatsApp al tre sette uno, uno nove tre, otto otto otto cinque. Intanto, se vuole, raccolgo io la richiesta.",
      message: "Usa spokenReply. Non trasferire fuori orario."
    };
  }
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
      spokenReply: "Al momento non riesco a trasferire la chiamata. Puo chiamarci o scriverci su WhatsApp al tre sette uno, uno nove tre, otto otto otto cinque. Intanto posso annotare la richiesta.",
      message: "Usa spokenReply."
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
    spokenReply: "La metto in contatto con un consulente.",
    message: "Trasferimento avviato. Non aggiungere altro."
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
      required: ["name", "interest", "startTime", "emailAsked"],
      properties: {
        name: { type: "string" },
        phone: { type: "string", description: "Telefono cliente se comunicato. Se non comunicato, il sistema usa il numero chiamante." },
        whatsappTo: { type: "string", description: "Numero WhatsApp cliente in formato whatsapp:+39..." },
        email: { type: "string", description: "Email cliente se disponibile; se il cliente non vuole darla lascia vuoto." },
        emailAsked: { type: "boolean", description: "True solo se Martina ha chiesto esplicitamente l'email al cliente." },
        emailUnavailable: { type: "boolean", description: "True se il cliente ha detto di non avere email o di non volerla comunicare." },
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
    description: "Da usare sempre quando il cliente chiede di parlare con un consulente vendite, un venditore, una persona, un operatore o un umano. Controlla orari e disponibilita e, se possibile, prepara il trasferimento reale. Non usare solo per fissare un appuntamento.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo del trasferimento richiesto dal cliente." },
        language: {
          type: "string",
          enum: ["it", "en"],
          description: "Lingua della conversazione: it se il cliente parla italiano, en se il cliente non parla italiano o la conversazione e in inglese."
        }
      }
    }
  },
  {
    type: "function",
    name: "chiudi_chiamata",
    description: "Chiude la telefonata dopo che Martina ha pronunciato il saluto finale, solo quando il cliente ha chiaramente concluso la conversazione.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Motivo della chiusura, per esempio saluti finali del cliente." }
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
  const callerPhone = normalizePhone(context.from);
  if (name === "cerca_auto") {
    const inventory = await searchInventoryDetailed(args);
    if (!hasInventoryFilters(args)) {
      return {
        results: [],
        count: inventory.totalAvailable,
        shownCount: 0,
        totalAvailable: inventory.totalAvailable,
        spokenReply: `In questo momento vedo ${inventory.totalAvailable} veicoli disponibili nel nostro parco. Che tipo di auto sta cercando?`,
        message: `Usa spokenReply. Non elencare modelli se il cliente ha chiesto solo il totale.`
      };
    }

    const hasSpecific = hasSpecificModelFilter(args);
    const spokenReply = inventorySpokenReply({
      ...inventory,
      hasSpecificModelFilter: hasSpecific
    });
    return {
      results: inventory.results,
      count: inventory.count,
      shownCount: inventory.results.length,
      totalAvailable: inventory.totalAvailable,
      hasSpecificModelFilter: hasSpecific,
      fallbackFromRequestedVehicle: inventory.fallbackFromRequestedVehicle,
      spokenReply,
      message: inventory.count
        ? `Usa spokenReply come base, senza leggere campi tecnici. Se hasSpecificModelFilter e false e ci sono molte auto, chiedi prima quale modello cerca invece di elencarle tutte. Se il cliente chiede dettagli base come cambio, carburante, colore o cavalli, usa detailLine o rispondi solo al dettaglio richiesto. Non aggiungere titoli, versioni, allestimenti, optional o descrizioni.`
        : `Usa spokenReply. Non dire che e impossibile: proponi ricerca su misura o verifica con consulente.`
    };
  }

  if (name === "controlla_disponibilita") {
    const weekendBlock = weekendAppointmentBlock(args, { fallbackToday: true });
    if (weekendBlock) return weekendBlock;

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
        const alternatives = (requestedSlot.alternatives || []).map(slimSlot).filter(Boolean);
        const nextAlternatives = (requestedSlot.nextAlternatives || []).map(slimSlot).filter(Boolean);
        const sameDayText = spokenAlternatives(alternatives);
        const nextDayText = spokenAlternatives(nextAlternatives);
        const alternativeText = alternatives.length
          ? `Alternative disponibili nello stesso giorno. ${sameDayText}.`
          : nextAlternatives.length
            ? `Per quel giorno non ci sono orari disponibili. Prime alternative nei giorni successivi. ${nextDayText}.`
            : "Non risultano alternative immediate: raccogli una preferenza e fai confermare da un consulente.";
        return {
          bookingSystemAvailable: true,
          requestedAvailable: Boolean(requestedSlot.available),
          requestedLabel: slot?.label || "orario richiesto",
          alternatives,
          nextAlternatives,
          reason: requestedSlot.reason || "",
          spokenReply: requestedSlot.available
            ? `${slot?.label || "L'orario richiesto"} e disponibile. Mi conferma nome, telefono ed email per bloccarlo?`
            : alternatives.length
              ? `Quell'orario non e disponibile. Le posso proporre queste alternative: ${sameDayText}. Quale preferisce?`
              : nextAlternatives.length
                ? `Per quel giorno non vedo orari liberi. Le propongo queste alternative: ${nextDayText}. Quale le torna meglio?`
                : "Per quell'orario non vedo disponibilita immediate. Mi lascia la preferenza e la faccio verificare in sede?",
          message: requestedSlot.available
            ? `Usa spokenReply. Se mancano nome, telefono o email chiedili prima di creare la prenotazione.`
            : `Usa spokenReply. ${alternativeText}`
        };
      }
      const slots = await withTimeout(
        getSimplyBookSlots(args),
        1800,
        "SimplyBook non ha risposto in tempo."
      );
      const alternatives = slots.slice(0, 2).map(slimSlot).filter(Boolean);
      const alternativesText = spokenAlternatives(alternatives);
      return {
        bookingSystemAvailable: true,
        alternatives,
        firstAvailable: alternatives[0] || null,
        spokenReply: alternatives.length
          ? `Le prime disponibilita che vedo sono queste: ${alternativesText}. Quale preferisce?`
          : "Non vedo orari liberi immediati. Mi dice giorno e fascia oraria preferiti e lo faccio verificare in sede?",
        message: alternatives.length
          ? `Usa spokenReply scandendo bene giorno e ora.`
          : "Usa spokenReply."
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
          "Martina deve raccogliere la preferenza e far confermare da un consulente.",
          args.localDate || args.localTime ? `Richiesta: ${[args.localDate, args.localTime].filter(Boolean).join(" ")}` : "",
          args.requestedStartTime ? `Orario richiesto: ${args.requestedStartTime}` : "",
          `Errore: ${error.message}`
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        slots: [],
        bookingSystemAvailable: false,
        spokenReply: "Il controllo agenda sta impiegando qualche secondo. Intanto mi lasci nome, giorno e orario preferito, cosi lo faccio verificare subito in sede.",
        message: "Usa spokenReply. Non restare in silenzio."
      };
    }
  }

  if (name === "crea_appuntamento") {
    const weekendBlock = weekendAppointmentBlock(args);
    if (weekendBlock) {
      return {
        appointment: null,
        ...weekendBlock
      };
    }

    if (!args.emailAsked) {
      return {
        appointment: null,
        missingEmailQuestion: true,
        spokenReply: "Mi lascia anche un indirizzo email per la conferma? Se preferisce non comunicarlo, va bene lo stesso.",
        message: "Usa spokenReply. Dopo la risposta potrai procedere."
      };
    }
    if (!args.email && !args.emailUnavailable) {
      return {
        appointment: null,
        missingEmailAnswer: true,
        spokenReply: "Mi conferma se vuole lasciarmi l'email o se preferisce procedere senza?",
        message: "Usa spokenReply."
      };
    }
    let appointment;
    try {
      appointment = await withTimeout(
        createSimplyBookBooking({
          ...args,
          phone: args.phone || callerPhone || context.from,
          callSid: context.callSid
        }),
        2800,
        "SimplyBook non ha creato l'appuntamento in tempo."
      );
    } catch (error) {
      const customerPhone = args.phone || callerPhone || context.from;
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
        spokenReply: "Ho preso nota della richiesta. La faccio verificare in sede e la ricontattiamo per la conferma definitiva.",
        message: "Usa spokenReply. Non dire confermato."
      };
    }
    const appointmentStart = appointment.start || args.startTime;
    const customerPhone = args.phone || callerPhone || context.from;
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
        label: spokenRomeDate(appointmentStart)
      },
      sellerNotified: true,
      spokenReply: `Va bene, ho fissato la visita per ${spokenRomeDate(appointmentStart)}. Ricevera la conferma dal nostro sistema.`,
      message: "Usa spokenReply. Non nominare SimplyBook e non ripetere la conferma."
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
    const to = normalizePhone(config.twilio.humanTransferTo);
    const client = getTwilioClient();
    if (!isBusinessOpenNow()) {
      notifySeller({
        body: [
          "Lead ExpoCar",
          `Cliente: ${context.from || "numero non disponibile"}`,
          "Richiesta: parlare con un consulente fuori orario",
          args.reason ? `Motivo: ${args.reason}` : "",
          "Trasferimento: non effettuato, fuori orario lavorativo",
          "Azione: ricontattare il cliente appena possibile"
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        ok: true,
        transferred: false,
        outsideBusinessHours: true,
        phone: to || config.twilio.humanTransferTo,
        language: conversationLanguage(args),
        spokenReply: transferOutsideHoursReply(args),
        message: "Usa spokenReply. Non trasferire fuori orario."
      };
    }
    if (!client || !context.callSid || !to) {
      notifySeller({
        body: [
          "Lead ExpoCar",
          `Cliente: ${context.from || "numero non disponibile"}`,
          "Richiesta: parlare con un consulente",
          "Trasferimento: non disponibile, comunicare numero diretto",
          args.reason ? `Motivo: ${args.reason}` : "",
          context.callSid ? `Call SID: ${context.callSid}` : ""
        ].filter(Boolean).join("\n")
      }).catch(() => {});
      return {
        ok: false,
        transferred: false,
        phone: to || config.twilio.humanTransferTo,
        language: conversationLanguage(args),
        spokenReply: transferUnavailableReply(args),
        message: "Usa spokenReply."
      };
    }
    return {
      ok: true,
      transferAfterResponse: true,
      phone: to,
      reason: args.reason,
      language: conversationLanguage(args),
      spokenReply: transferReply(args),
      message: "Usa spokenReply e non aggiungere altro. Il trasferimento parte dopo la frase."
    };
  }

  if (name === "chiudi_chiamata") {
    return {
      ok: true,
      closeAfterResponse: true,
      spokenReply: "Grazie a lei, buona giornata.",
      message: "Usa spokenReply e non aggiungere altro. La chiamata verra chiusa dopo la risposta."
    };
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
