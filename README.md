# Dispatch

An editorial newsroom desk. Dispatch reads the current edition of the news and answers questions from the reporting, with every claim tied to a numbered source.

Live: **https://dispatch.kp489292.workers.dev**

## What it is

Dispatch is a small RAG application, not a trained language model. It pulls public RSS feeds, reads each article, embeds passages, retrieves the passages that match a question, and asks a hosted language model to answer from those passages only. The answer streams back with citations.

The design is deliberately print-like: warm paper, oxblood, a serif masthead, hairline rules, and no dashboard chrome.

## How it works

```
RSS feeds ──► article text ──► passages ──► BGE embeddings ──► Vectorize
                                                                  │
reader question ──► BGE embedding ──► vector search ──────────────┘
                                             │
                                             ▼
                              Llama 3.3 70B (Workers AI)
                                             │
                                             ▼
                                 streamed answer + citations
```

- **Collect** — The Conversation, ProPublica, Ars Technica and The Verge publish full-text RSS/Atom entries. Every four hours a cron trigger rebuilds the edition: reads each entry, splits the text into passages and replaces the previous edition.
- **Retrieve** — the question is embedded with `@cf/baai/bge-small-en-v1.5` (384 dimensions) and matched against the `dispatch-news` Vectorize index.
- **Answer** — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` receives the top passages with instructions to use only those sources and cite them as `[1]`, `[2]`. Responses stream over server-sent events. The 8B FP8 model is a fallback.
- **Store** — D1 holds the edition metadata and passages; Vectorize holds the embeddings; static assets are served by Cloudflare's asset layer.

No external API keys are required at runtime: Workers AI, Vectorize and D1 are native bindings on the same account.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service status, model names, story and passage counts, last ingest time |
| `GET` | `/api/articles` | The current edition, newest first |
| `POST` | `/api/chat` | `{ "message": "...", "history": [...] }` → SSE stream (`citations`, `token`, `done`, `error`) |
| `POST` | `/api/ingest` | Rebuild the edition. Requires the `x-ingest-key` header matching the `INGEST_KEY` secret |

## Local development

```bash
npm install
npm run typecheck
npx wrangler dev --remote --port 8787
```

`--remote` is needed because the Worker uses real Workers AI, Vectorize and D1 bindings. The site is then available at `http://localhost:8787`.

Apply the schema to a fresh database:

```bash
npx wrangler d1 execute dispatch --remote --file=./schema.sql
```

Set the ingest key and build an edition:

```bash
npx wrangler secret put INGEST_KEY
curl -X POST http://localhost:8787/api/ingest -H "x-ingest-key: <key>"
```

## Deployment

```bash
npx wrangler deploy
```

`wrangler.jsonc` contains the bindings:

- `AI` — Workers AI
- `VECTORIZE` — `dispatch-news` (384 dimensions, cosine)
- `DB` — D1 database `dispatch`
- `ASSETS` — static files in `public/`

The cron trigger `17 */4 * * *` refreshes the edition.

## Design notes

- **Palette** — paper `#F4EFE4`, ink `#1A1712`, oxblood `#7A2A22`, rules `#D5C9B6`. No gradients, no glass, no emoji.
- **Type** — Newsreader for display and reading, Inter for labels and controls. Both are self-hosted variable fonts.
- **Honesty** — the interface says the answers come from the current RSS edition and may be incomplete. The system prompt forbids outside knowledge and invented facts.
- **Safety** — source text is treated as reporting, not instruction. The prompt explicitly tells the model to ignore commands inside articles.

## Limitations

- RSS and Atom entries vary in length; some publishers publish only a summary.
- The edition is a snapshot. Old vectors are removed when the edition is rebuilt.
- This is a demonstration, not a verified news product. Reporting belongs to its publishers.

## Stack

Cloudflare Workers · Workers AI · Vectorize · D1 · TypeScript · vanilla HTML/CSS/JS

## License

MIT
