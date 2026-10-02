import { expect, spyOn, test } from "bun:test";
import { startServer } from "./index";
import { pollOnce } from "./bot";

test("bot forwards complete requests, retries failures, and respects existing answers", async () => {
  const app = startServer({ database: ":memory:", port: 0 });
  const serviceUrl = `http://127.0.0.1:${app.server.port}`;
  const answers = {
    color: { type: "choice", choice: "r", probabilities: { r: 0.9857306292510398, b: 0.009181745549832256, g: 0.005087625199127883 }, confidence: 0.9785959438765596 },
    box: { type: "noul", noul: 0.8407888865928814 },
    certainty: { type: "score", score: 1, probabilities: { "0": 0, "1": 1 }, confidence: 1 },
  };
  const questions = {
    color: { type: "choice", instructions: "What color is the ball?", criteria: { r: "Red", b: "Blue", g: "Green" } },
    box: { type: "noul", instructions: "Is the box blue?" },
    certainty: { type: "score", instructions: "How certain?", criteria: ["Uncertain", "Certain"] },
  };
  const ids = new Map<string, string>();
  const attempts = new Map<string, number>();
  const forwarded: unknown[] = [];
  const logs = spyOn(console, "log").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const model = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/poll") return Response.json({ error: "Unavailable" }, { status: 503 });
      expect(new URL(req.url).pathname).toBe("/v1/systemone");
      expect(req.method).toBe("POST");
      const body = await req.json() as { state: { text: string; mode: string }; questions: unknown };
      forwarded.push(body);
      const mode = body.state.mode;
      const attempt = (attempts.get(mode) ?? 0) + 1;
      attempts.set(mode, attempt);
      if (mode === "retry" && attempt === 1) return Response.json({ error: "Temporary model failure" }, { status: 503 });
      if (mode === "invalid" && attempt === 1) return Response.json({ answers: null });
      if (mode === "race") {
        const response = await fetch(`${serviceUrl}/v1/decisions/${ids.get(mode)}/answers`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }),
        });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
      return Response.json({ model: "/home/mod/Laya-BF16.gguf", answers, usage: { input_tokens: 74, output_tokens: 0 } });
    },
  });
  try {
    for (const mode of ["retry", "success", "invalid", "race"]) {
      const response = await fetch(`${serviceUrl}/v1/decisions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "human", state: { text: "The red ball is inside the blue box.", mode }, questions }),
      });
      const { id } = await response.json() as { id: string };
      ids.set(mode, id);
    }
    const modelUrl = `http://127.0.0.1:${model.port}/v1/systemone`;
    await pollOnce(serviceUrl, modelUrl);
    const pending = await (await fetch(`${serviceUrl}/poll`)).json() as { decisions: { id: string }[] };
    expect(pending.decisions.map(decision => decision.id)).toEqual([ids.get("retry")!, ids.get("invalid")!]);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(logs.mock.calls.flat().some(line => String(line).includes("Already answered"))).toBe(true);
    await pollOnce(serviceUrl, modelUrl);
    expect(await (await fetch(`${serviceUrl}/poll`)).json()).toEqual({ decisions: [] });
    for (const [mode, id] of ids) {
      const result = await (await fetch(`${serviceUrl}/v1/decisions/${id}`)).json() as { answers: unknown };
      expect(result.answers).toEqual({ ...answers, certainty: { ...answers.certainty, legend: { "0": "Uncertain", "1": "Certain" } } });
      expect(attempts.get(mode)).toBe(mode === "retry" || mode === "invalid" ? 2 : 1);
    }
    expect(forwarded[1]).toEqual({ state: { text: "The red ball is inside the blue box.", mode: "success" }, questions });
    await pollOnce(serviceUrl, modelUrl);
    expect(forwarded.length).toBe(6);
    await expect(pollOnce(`http://127.0.0.1:${model.port}`, modelUrl)).rejects.toThrow("HTTP 503");
  } finally {
    logs.mockRestore();
    errors.mockRestore();
    await model.stop(true);
    await app.server.stop(true);
    app.db.close();
  }
});
