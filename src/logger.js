import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const logPath = path.join(dataDir, "server.log");

export function logEvent(type, payload = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    type,
    ...payload
  };
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  return record;
}
