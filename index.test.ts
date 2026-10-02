import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index";
import { buildAnswer } from "./frontend";

test("website selections produce valid API answers without inventing distributions", () => {
  const noul = { type: "noul", instructions: "Yes?" } as const;
  const choice = { type: "choice", instructions: "Team?", criteria: { billing: "Billing", technical: "Technical" } } as const;
  const score = { type: "score", instructions: "Urgency?", criteria: ["Low", "High"] } as const;
  expect(buildAnswer(noul, "0.73")).toEqual({ type: "noul", noul: 0.73 });
  expect(buildAnswer(choice, "billing", 0.8)).toEqual({ type: "choice", choice: "billing", probabilities: { billing: 1, technical: 0 }, confidence: 0.8 });
  expect(buildAnswer({ ...score, criteria: [...score.criteria] }, "0", 0.9)).toEqual({ type: "score", score: 0, probabilities: { "0": 1, "1": 0 }, confidence: 0.9 });
  for (const invalid of ["", "no", "-1", "1.01"]) expect(() => buildAnswer(noul, invalid)).toThrow();
  expect(() => buildAnswer(choice, "missing")).toThrow();
  expect(() => buildAnswer(choice, "billing", 1.1)).toThrow();
});

test("humans poll, answer all question types, and retrieve durable decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "human-decisions-"));
  const database = join(directory, "decisions.sqlite");
  let app = startServer({ database, port: 0 });
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(new URL(path, app.server.url), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const decision = {
    model: "needle-research",
    state: "Zoë needs a refund for a damaged Café mug.",
    questions: {
      refund: { type: "noul", instructions: "Is a refund requested?" },
      team: { type: "choice", instructions: "Which team?", criteria: { billing: "Refunds", technical: "Bugs" } },
      frustration: { type: "score", instructions: "How frustrated?", criteria: ["Calm", "Frustrated", "Very angry"] },
    },
  };
  const answers = {
    refund: { type: "noul", noul: 0.96 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.84 },
    frustration: { type: "score", score: 1.04, probabilities: { "0": 0, "1": 0.96, "2": 0.04 }, confidence: 0.93 },
  };
  try {
    expect(app.server.hostname).toBe("0.0.0.0");
    expect(app.server.development).toBe(false);
    const homepage = await request("/");
    expect(homepage.status).toBe(200);
    expect(homepage.headers.get("Content-Type")).toContain("text/html");
    const html = await homepage.text();
    expect(html).toContain("Good decisions.");
    expect(html).toContain('id="ask-form"');
    expect(html).toContain("Public workspace");
    expect(html).toContain("Public &amp; anonymous");
    const faviconPath = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/)?.[1];
    expect(faviconPath).toBeDefined();
    const favicon = await request(faviconPath!);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(await favicon.text()).toContain('viewBox="0 0 64 64"');
    const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css)(?:\?[^\"]*)?)"/g)];
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) expect((await request(asset[1]!)).status).toBe(200);
    expect((await request("/poll")).status).toBe(200);
    expect(await (await request("/poll")).json()).toEqual({ decisions: [] });
    for (const body of [null, {}, { state: "x", questions: {} }, { ...decision, questions: { bad: { type: "choice", instructions: "Pick", criteria: [] } } }, { ...decision, questions: { bad: { type: ["noul"], instructions: "Yes?" } } }]) {
      expect((await request("/v1/decisions", body)).status).toBe(400);
    }
    const malformed = await fetch(new URL("/v1/decisions", app.server.url), { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    expect((await request("/v1/decisions")).status).toBe(405);
    expect((await request("/v1/decisions/missing")).status).toBe(404);
    expect((await request("/v1/decisions/missing/answers", { answers })).status).toBe(404);
    const submitted = await request("/v1/decisions", decision);
    expect(submitted.status).toBe(202);
    const { id } = await submitted.json() as { id: string };
    const path = `/v1/decisions/${id}`;
    expect(submitted.headers.get("Location")).toBe(path);
    const pending = { id, status: "pending", ...decision };
    expect(await (await request(path)).json()).toEqual(pending);
    expect(await (await request("/poll")).json()).toEqual({ decisions: [pending] });

    // Pending questions and completed answers both survive a server restart.
    await app.server.stop(true);
    app.db.close();
    app = startServer({ database, port: 0 });
    expect(await (await request(path)).json()).toEqual(pending);
    for (const invalid of [
      {},
      { refund: answers.refund },
      { ...answers, extra: answers.refund },
      { ...answers, refund: { type: "noul", noul: 1.1 } },
      { ...answers, team: { ...answers.team, type: "score" } },
      { ...answers, team: { ...answers.team, choice: "missing" } },
      { ...answers, team: { ...answers.team, probabilities: { billing: 0.2, technical: 0.2 } } },
      { ...answers, team: { ...answers.team, probabilities: { billing: 1 } } },
      { ...answers, team: { ...answers.team, confidence: -1 } },
      { ...answers, frustration: { ...answers.frustration, score: 3 } },
    ]) {
      expect((await request(`${path}/answers`, { answers: invalid })).status).toBe(400);
    }
    expect(await (await request("/poll")).json()).toEqual({ decisions: [pending] });
    const results = await Promise.all([request(`${path}/answers`, { answers }), request(`${path}/answers`, { answers })]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const completed = {
      id, status: "answered", model: "needle-research", provider: "human",
      answers: { ...answers, frustration: { ...answers.frustration, legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" } } },
    };
    expect(await results.find(result => result.status === 200)!.json()).toEqual(completed);
    expect(await (await request(path)).json()).toEqual(completed);
    expect(await (await request("/poll")).json()).toEqual({ decisions: [] });
    await app.server.stop(true);
    app.db.close();
    app = startServer({ database, port: 0 });
    expect(await (await request(path)).json()).toEqual(completed);
    expect((await request(`${path}/answers`, { answers })).status).toBe(409);
  } finally {
    await app.server.stop(true);
    app.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
