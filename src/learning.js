import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const feedbackPath = path.join(dataDir, "learning-feedback.jsonl");

function clean(value, maxLength = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function saveLearningFeedback(feedback = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const record = {
    createdAt: new Date().toISOString(),
    callSid: clean(feedback.callSid, 120),
    category: clean(feedback.category || "generale", 80),
    issue: clean(feedback.issue, 1000),
    desiredBehavior: clean(feedback.desiredBehavior, 1000),
    proposedRule: clean(feedback.proposedRule, 1000),
    status: "pending_review"
  };
  fs.appendFileSync(feedbackPath, `${JSON.stringify(record)}\n`);
  return record;
}

export function readLearningFeedback(limit = 50) {
  if (!fs.existsSync(feedbackPath)) return [];
  const lines = fs.readFileSync(feedbackPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => JSON.parse(line));
}
