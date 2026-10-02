const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function json(url: string | URL, body?: unknown, apiKey?: string) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!object(data)) throw new Error(`${url}: expected a JSON object`);
  return data;
}

export async function pollOnce(decisionsUrl: string, systemoneUrl: string, apiKey?: string, model?: string) {
  const queue = await json(new URL("/poll", decisionsUrl));
  if (!Array.isArray(queue.decisions)) throw new Error("/poll: expected a decisions array");
  // ponytail: sequential inference for a single model backend; add concurrency if it supports parallel requests.
  for (const decision of queue.decisions) {
    try {
      if (!object(decision) || typeof decision.id !== "string" || !decision.id || !Object.hasOwn(decision, "state") || !object(decision.questions)) {
        throw new Error("/poll: malformed decision");
      }
      const prediction = await json(systemoneUrl, { ...(model ? { model } : {}), state: decision.state, questions: decision.questions }, apiKey);
      if (!object(prediction.answers)) throw new Error("SystemOne: expected an answers object");
      const response = await fetch(new URL(`/v1/decisions/${encodeURIComponent(decision.id)}/answers`, decisionsUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: prediction.answers }),
        signal: AbortSignal.timeout(60_000),
      });
      await response.body?.cancel();
      if (response.status === 409) console.log(`Already answered: ${decision.id}`);
      else if (!response.ok) throw new Error(`${decision.id}: answer submission returned HTTP ${response.status}`);
      else console.log(`Answered: ${decision.id}`);
    } catch (error) {
      // Failed requests stay pending and are retried on the next poll; one failure does not stop the batch.
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

if (import.meta.main) {
  const decisionsUrl = Bun.env.DECISIONS_URL ?? `http://127.0.0.1:${Bun.env.PORT ?? 8001}`;
  const systemoneUrl = Bun.env.SYSTEMONE_URL ?? "http://192.168.0.124:8888/v1/systemone";
  const interval = Number(Bun.env.POLL_INTERVAL_MS ?? 3000);
  if (!Number.isFinite(interval) || interval < 100) throw new Error("POLL_INTERVAL_MS must be at least 100");
  // Fail fast on invalid configuration, but keep running through temporary network failures.
  new URL(decisionsUrl);
  new URL(systemoneUrl);
  console.log(`Bot watching ${decisionsUrl}/poll using ${systemoneUrl}`);
  while (true) {
    try { await pollOnce(decisionsUrl, systemoneUrl, Bun.env.SYSTEMONE_API_KEY, Bun.env.SYSTEMONE_MODEL); }
    catch (error) { console.error(error instanceof Error ? error.message : error); }
    await Bun.sleep(interval);
  }
}
