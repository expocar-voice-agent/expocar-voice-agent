import "dotenv/config";
import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;
const toNumber = process.env.TEST_CALL_TO || "+393711938885";
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (!accountSid || !authToken || !fromNumber || !toNumber || !publicBaseUrl) {
  throw new Error("Missing Twilio test call configuration");
}

const client = twilio(accountSid, authToken);

try {
const call = await client.calls.create({
    from: fromNumber,
    to: toNumber,
    url: `${publicBaseUrl}/twilio/voice`,
    method: "POST",
    statusCallback: `${publicBaseUrl}/twilio/status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
  });

  console.log(JSON.stringify({
    sid: call.sid,
    status: call.status,
    from: call.from,
    to: call.to
  }, null, 2));
} catch (error) {
  console.error(`Twilio test call failed: ${error.code || error.message}`);
  process.exit(1);
}
