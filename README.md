# Human decisions

Humans or an optional SystemOne bot answer `noul`, `choice`, and `score` questions through an API. Bun and its built-in SQLite are the only runtime requirements.

```sh
bun install
bun run index.ts
bun test
```

The server listens on `0.0.0.0:8001` (all IPv4 interfaces) for public, anonymous access. Configure `PORT` and `DATABASE_PATH` through environment variables. The default database is `decisions.sqlite`; requests and answers survive restarts.

## Website

Open **http://127.0.0.1:8001** on the server, or **http://<server-ip>:8001** remotely when your firewall allows it. For an internet deployment, point your domain and an HTTPS reverse proxy at the service. No accounts or API keys are required. The responsive workspace lets you:

- Submit context and multiple yes/no, choice, or scale questions.
- Refresh the unanswered inbox and submit human answers with native controls.
- Look up a request ID to check its status and results.

The website uses the same API, with no frontend dependencies or separate build step. Choice and scale controls submit definite selections (one-hot probabilities); confidence is adjustable. Use the API for mixed distributions and fractional scores. Keep your request ID to check the answer later; refresh and result checks are manual.

## Optional SystemOne bot

With the decisions server running, run `bun run bot.ts` in another terminal. It polls `/poll`, sends `state`, `questions`, and an optional `model` to the inference endpoint, and posts only `answers` back.

Example using OpenRouter:

```sh
DECISIONS_URL=http://127.0.0.1:8001 \
SYSTEMONE_URL=https://openrouter.ai/api/alpha/decisions \
SYSTEMONE_MODEL=typesafe/jev-1.13 \
SYSTEMONE_API_KEY='<apikey>' \
POLL_INTERVAL_MS=3000 bun run bot.ts
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECISIONS_URL` | `http://127.0.0.1:8001` (uses `PORT` if set) | Decisions service |
| `SYSTEMONE_URL` | `http://192.168.0.124:8888/v1/systemone` | Inference endpoint |
| `SYSTEMONE_MODEL` | Unset | Optional model name; does not use queued request metadata |
| `SYSTEMONE_API_KEY` | Unset | Optional Bearer token sent only to the inference endpoint |
| `POLL_INTERVAL_MS` | `3000` | Delay after each batch, minimum 100 ms |

Unset or empty model/key values preserve endpoint defaults and unauthenticated inference. Polling and answer submissions remain anonymous. Use HTTPS for remote inference to protect the key.

Requests run sequentially with a 60-second timeout. Failures are retried on the next poll; already-answered requests (409) are skipped. Stop with Ctrl+C.

Bot answers are **AI-generated**. The API still reports `provider: "human"` and does not track authorship; website labels do not distinguish bot answers from human ones.

## API flow

1. A client submits `state` and `questions` to `POST /v1/decisions`, as shown in the curl example below.
2. The API returns HTTP **202** with `{ "id": "gen-dec-…", "status": "pending" }` and a `Location` header. Human replies are asynchronous, not immediate model predictions.
3. Human agents call `GET /poll`, which returns `{ "decisions": [...] }` with up to 100 oldest unanswered requests, including their IDs, state, and questions.
4. An agent submits `{ "answers": {...} }` to `POST /v1/decisions/:id/answers`. All questions must be answered together. The first valid submission wins; later submissions return **409**.
5. The client calls `GET /v1/decisions/:id` until `status` is `answered`. The completed response contains `id`, `status`, `model`, `provider: "human"`, and `answers` using the answer formats below.

`model` is optional metadata, defaults to `human`, and does not invoke or route to an AI. No model token usage or cost is fabricated.

### Try it

```sh
curl http://127.0.0.1:8001/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{"state":"Please refund my order","questions":{"refund":{"type":"noul","instructions":"Does the customer request a refund?"}}}'

curl http://127.0.0.1:8001/poll

# Replace ID with the submitted decision ID.
curl http://127.0.0.1:8001/v1/decisions/ID/answers \
  -H 'Content-Type: application/json' \
  -d '{"answers":{"refund":{"type":"noul","noul":1}}}'

curl http://127.0.0.1:8001/v1/decisions/ID
```

### Answer formats

- `noul`: `{ "type": "noul", "noul": 0.96 }`, with a probability from 0 to 1.
- `choice`: `{ "type": "choice", "choice": "billing", "probabilities": { "billing": 0.9, "technical": 0.1 }, "confidence": 0.84 }`. Criteria map up to 255 option keys to descriptions.
- `score`: `{ "type": "score", "score": 1.04, "probabilities": { "0": 0, "1": 0.96, "2": 0.04 }, "confidence": 0.93 }`. Criteria are an array of at least two labels. Scores range from 0 to `criteria.length - 1`; the server generates the `legend`.

Choice and score probabilities must cover exactly every option and sum to 1, within a tolerance of 0.000001. Confidence ranges from 0 to 1. Answer submitters supply probabilities, confidence, and scores; the server validates their shape and bounds, not whether the answers are correct. Malformed submissions return **400** without consuming a pending request; unknown IDs return **404**. Request bodies are limited to 1 MiB.

This service is public and anonymous by design. Anyone can submit questions, view pending context, and answer without an account or API key. Treat submitted context and answers as public, not private. Polling does not reserve work, so agents can duplicate effort; the first valid complete answer wins. There is no task claiming. The server does not call AI itself; the optional bot submits model answers through the same agent API.
