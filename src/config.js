import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalNumber(name, fallback) {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

export const config = {
  port: optionalNumber("PORT", 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  openai: {
    apiKey: required("OPENAI_API_KEY"),
    projectId: process.env.OPENAI_PROJECT_ID || "",
    webhookSecret: process.env.OPENAI_WEBHOOK_SECRET || "",
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    voice: process.env.OPENAI_REALTIME_VOICE || "cedar",
    speed: optionalNumber("OPENAI_REALTIME_SPEED", 1.2),
    summaryModel: process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini"
  },
  cartesia: {
    apiKey: process.env.CARTESIA_API_KEY || "",
    modelId: process.env.CARTESIA_MODEL_ID || "sonic-3",
    voiceId: process.env.CARTESIA_VOICE_ID || "e07c00bc-4134-4eae-9ea4-1a55fb45746b",
    version: process.env.CARTESIA_VERSION || "2026-03-01",
    demoText: process.env.CARTESIA_DEMO_TEXT || ""
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    fromNumber: process.env.TWILIO_FROM_NUMBER || "",
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || "",
    sellerWhatsappTo: process.env.SELLER_WHATSAPP_TO || "whatsapp:+393711938885",
    humanTransferTo: process.env.HUMAN_TRANSFER_PHONE || "+393711938885",
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || "",
    customerTemplateContentSid: process.env.TWILIO_CUSTOMER_TEMPLATE_CONTENT_SID || "",
    appointmentTemplateContentSid: process.env.TWILIO_APPOINTMENT_TEMPLATE_CONTENT_SID || ""
  },
  multigestionale: {
    userApi: required("MULTIGESTIONALE_USER_API"),
    engine: process.env.MULTIGESTIONALE_ENGINE || "car"
  },
  google: {
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    authMode: process.env.GOOGLE_AUTH_MODE || "oauth",
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || ""
  },
  business: {
    publicPhone: process.env.BUSINESS_PUBLIC_PHONE || "+390809997271",
    timezone: process.env.BUSINESS_TIMEZONE || "Europe/Rome",
    openHour: optionalNumber("BUSINESS_OPEN_HOUR", 10),
    closeHour: optionalNumber("BUSINESS_CLOSE_HOUR", 19),
    durationMinutes: optionalNumber("APPOINTMENT_DURATION_MINUTES", 60),
    minNoticeHours: optionalNumber("APPOINTMENT_MIN_NOTICE_HOURS", 6),
    slotMinutes: optionalNumber("APPOINTMENT_SLOT_MINUTES", 60),
    locationUrl: process.env.LOCATION_URL || "https://maps.app.goo.gl/dZk69BM7kEjkKj8r6"
  }
};
