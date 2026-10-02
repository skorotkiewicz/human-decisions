import { Database } from "bun:sqlite";
import website from "./index.html";

export type Question = {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
};
export type Decision = { model: string; state: unknown; questions: Record<string, Question> };
type Row = { id: string; request: string; response: string | null };

class InputError extends Error {}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InputError(message);
}

function validateDecision(input: unknown): Decision {
  check(object(input), "Expected a JSON object");
  check(Object.hasOwn(input, "state"), "state is required");
  check(input.model === undefined || (typeof input.model === "string" && input.model.trim()), "model must be a nonempty string");
  check(object(input.questions) && Object.keys(input.questions).length > 0, "questions must be a nonempty object");
  for (const [name, question] of Object.entries(input.questions)) {
    check(name.trim() && object(question), "Each question needs a name and an object");
    check(typeof question.instructions === "string" && question.instructions.trim(), `${name}: instructions are required`);
    check(question.type === "noul" || question.type === "choice" || question.type === "score", `${name}: unknown question type`);
    if (question.type === "score") {
      check(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.every(label => typeof label === "string" && label.trim()), `${name}: score criteria must contain at least two labels`);
    } else if (question.type === "choice" || question.criteria !== undefined) {
      check(object(question.criteria) && Object.keys(question.criteria).length > 0 && Object.entries(question.criteria).every(([key, label]) => key.trim() && typeof label === "string" && label.trim()), `${name}: criteria must map options to descriptions`);
      if (question.type === "choice") check(Object.keys(question.criteria).length <= 255, `${name}: at most 255 options are allowed`);
      else check(Object.keys(question.criteria).length === 2 && Object.hasOwn(question.criteria, "true") && Object.hasOwn(question.criteria, "false"), `${name}: noul criteria must contain true and false`);
    }
  }
  return { model: (input.model as string | undefined) ?? "human", state: input.state, questions: input.questions as Record<string, Question> };
}

function validateAnswers(input: unknown, questions: Decision["questions"]) {
  check(object(input) && object(input.answers), "answers must be an object");
  const answers = input.answers;
  check(Object.keys(answers).length === Object.keys(questions).length && Object.keys(answers).every(name => Object.hasOwn(questions, name)), "Answer every question exactly once");
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const answer = answers[name];
    check(object(answer) && answer.type === question.type, `${name}: answer type must match the question`);
    if (question.type === "noul") {
      check(probability(answer.noul), `${name}: noul must be between 0 and 1`);
      return [name, { type: "noul", noul: answer.noul }];
    }
    const labels = question.type === "choice"
      ? question.criteria as Record<string, string>
      : Object.fromEntries((question.criteria as string[]).map((label, index) => [String(index), label]));
    const options = Object.keys(labels);
    const probabilities = answer.probabilities;
    check(object(probabilities) && Object.keys(probabilities).length === options.length && options.every(option => Object.hasOwn(probabilities, option) && probability(probabilities[option])), `${name}: probabilities must cover every option with values between 0 and 1`);
    check(Math.abs(Object.values(probabilities).reduce<number>((sum, value) => sum + (value as number), 0) - 1) <= 0.000001, `${name}: probabilities must sum to 1`);
    check(probability(answer.confidence), `${name}: confidence must be between 0 and 1`);
    if (question.type === "choice") {
      check(typeof answer.choice === "string" && Object.hasOwn(labels, answer.choice), `${name}: choice must be a known option`);
      return [name, { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence }];
    }
    check(typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= options.length - 1, `${name}: score must be within the criteria scale`);
    return [name, { type: "score", score: answer.score, legend: labels, probabilities, confidence: answer.confidence }];
  }));
}

function serialize(row: Row) {
  const request: Decision = JSON.parse(row.request);
  return row.response === null
    ? { id: row.id, status: "pending", ...request }
    : { id: row.id, status: "answered", model: request.model, provider: "human", answers: JSON.parse(row.response) };
}

export function startServer({ database = "decisions.sqlite", port = 8001 }: { database?: string; port?: number } = {}) {
  const db = new Database(database, { create: true });
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      response TEXT
    );`);
  const insert = db.query("INSERT INTO decisions (id, request) VALUES (?, ?)");
  const get = db.query<Row, [string]>("SELECT id, request, response FROM decisions WHERE id = ?");
  const pending = db.query<Row, []>("SELECT id, request, response FROM decisions WHERE response IS NULL ORDER BY rowid LIMIT 100");
  const answer = db.query("UPDATE decisions SET response = ? WHERE id = ? AND response IS NULL");
  const json = Response.json;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    development: false,
    port,
    maxRequestBodySize: 1024 * 1024,
    routes: { "/": website },
    async fetch(req) {
      try {
        const path = new URL(req.url).pathname;
        if (path === "/poll") {
          if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
          // ponytail: no claims, so agents may duplicate work; add leases if that becomes costly.
          return json({ decisions: pending.all().map(serialize) });
        }
        if (path === "/v1/decisions") {
          if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
          const decision = validateDecision(await req.json());
          const id = `gen-dec-${crypto.randomUUID()}`;
          insert.run(id, JSON.stringify(decision));
          return json({ id, status: "pending" }, { status: 202, headers: { Location: `/v1/decisions/${id}` } });
        }
        const match = /^\/v1\/decisions\/([^/]+)(\/answers)?$/.exec(path);
        if (!match) return json({ error: "Not found" }, { status: 404 });
        const method = match[2] ? "POST" : "GET";
        if (req.method !== method) return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: method } });
        const row = get.get(match[1]!);
        if (!row) return json({ error: "Decision not found" }, { status: 404 });
        if (!match[2]) return json(serialize(row));
        if (row.response !== null) return json({ error: "Decision already answered" }, { status: 409 });
        const decision: Decision = JSON.parse(row.request);
        const answers = validateAnswers(await req.json(), decision.questions);
        // The conditional update makes the first complete answer win, even across server processes.
        if (!answer.run(JSON.stringify(answers), row.id).changes) return json({ error: "Decision already answered" }, { status: 409 });
        return json(serialize(get.get(row.id)!));
      } catch (error) {
        if (error instanceof InputError || error instanceof SyntaxError) return json({ error: error.message }, { status: 400 });
        console.error(error);
        return json({ error: "Internal server error" }, { status: 500 });
      }
    },
  });
  return { server, db };
}

if (import.meta.main) {
  const { server } = startServer({ database: Bun.env.DATABASE_PATH ?? "decisions.sqlite", port: Number(Bun.env.PORT ?? 8001) });
  console.log(`Human decisions API listening on ${server.url}`);
}
