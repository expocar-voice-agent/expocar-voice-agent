import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const leadsPath = path.join(dataDir, "leads.jsonl");

export function saveLead(lead) {
  fs.mkdirSync(dataDir, { recursive: true });
  const record = {
    createdAt: new Date().toISOString(),
    ...lead
  };
  fs.appendFileSync(leadsPath, `${JSON.stringify(record)}\n`);
  return record;
}

export function readRecentLeads(limit = 20) {
  if (!fs.existsSync(leadsPath)) return [];
  const lines = fs.readFileSync(leadsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line));
}
