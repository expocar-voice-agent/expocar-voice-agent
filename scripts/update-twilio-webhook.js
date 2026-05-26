import "dotenv/config";
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (!accountSid || !authToken || !fromNumber || !publicBaseUrl) {
  throw new Error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, or PUBLIC_BASE_URL");
}

const client = twilio(accountSid, authToken);

try {
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber, limit: 1 });

  if (!numbers.length) {
    throw new Error(`No Twilio incoming number found for ${fromNumber}`);
  }

  const updated = await client.incomingPhoneNumbers(numbers[0].sid).update({
    voiceUrl: `${publicBaseUrl}/twilio/voice`,
    voiceMethod: "POST"
  });

  console.log(JSON.stringify({
    phoneNumber: updated.phoneNumber,
    voiceUrl: updated.voiceUrl,
    voiceMethod: updated.voiceMethod
  }, null, 2));
} catch (error) {
  console.error(`Twilio webhook update failed: ${error.code || error.message}`);
  process.exit(1);
}
