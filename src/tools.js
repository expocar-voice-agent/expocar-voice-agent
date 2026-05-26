import { searchInventory } from "./inventory.js";
import { createAppointment, getAvailableSlots } from "./calendar.js";
import { saveLead } from "./leads.js";
import { notifySeller, sendAppointmentWhatsapp } from "./whatsapp.js";

export const realtimeTools = [
  {
    type: "function",
    name: "cerca_auto",
    description: "Cerca auto disponibili nel parco Expocar tramite MultiGestionale.",
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
    description: "Trova fino a 3 slot disponibili per appuntamenti in sede.",
    parameters: {
      type: "object",
      properties: {
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
    description: "Crea un appuntamento su Google Calendar e invia WhatsApp di conferma.",
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
    return { results };
  }

  if (name === "controlla_disponibilita") {
    try {
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
    saveLead({
      type: "appointment",
      name: args.name,
      phone: args.phone,
      interest: args.interest,
      startTime: args.startTime,
      notes: args.notes,
      appointment
    });
    if (args.whatsappTo) {
      try {
        await sendAppointmentWhatsapp({
          to: args.whatsappTo,
          name: args.name,
          startTime: args.startTime
        });
      } catch (error) {
        saveLead({
          type: "whatsapp_customer_failed",
          phone: args.phone,
          whatsappTo: args.whatsappTo,
          error: error.message
        });
      }
    }
    try {
      await notifySeller({
        body: `Nuovo appuntamento Expocar\nCliente: ${args.name}\nTelefono: ${args.phone}\nInteresse: ${args.interest}\nOrario: ${args.startTime}`
      });
    } catch (error) {
      saveLead({
        type: "whatsapp_seller_failed",
        phone: args.phone,
        error: error.message
      });
    }
    return { appointment };
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
