import "dotenv/config";
import { spawn } from "node:child_process";

const intervalSeconds = Number(process.env.DIDWW_WAIT_INTERVAL_SECONDS || 300);

function runConfigure() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/configure-didww-sip.js"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

while (true) {
  const result = await runConfigure();
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] configure exit=${result.code}`);
  console.log(result.output.trim());

  try {
    const jsonStart = result.output.indexOf("{");
    const parsed = JSON.parse(result.output.slice(jsonStart));
    if (parsed.assigned) {
      console.log("DIDWW pronto: numero assegnato al trunk OpenAI.");
      break;
    }
  } catch {
    // Keep polling on transient network or parse errors.
  }

  console.log(`Numero non ancora assegnato. Riprovo tra ${intervalSeconds} secondi.`);
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}
