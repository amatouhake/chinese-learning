# Chinese Learning

A personal, offline-sync-ready Chinese-learning application. The current foundation implements
vocabulary content, immutable learning attempts, exact-config FSRS reviews, deterministic replay,
and materialized card state on Cloudflare D1.

This is intentionally the first usable slice, not the whole product. Pronunciation, reading,
grammar, dashboard, Notion projection, PWA media sync, and Remote MCP product surfaces remain
deferred.

## Stack and topology

- TypeScript, Bun 1.4.x, Svelte 5, and Vite
- Hono on a Cloudflare Worker
- Worker Static Assets for the SPA
- Cloudflare D1, accessed with prepared SQL and atomic `D1Database.batch()` writes
- `ts-fsrs` 5.4.1 with explicit, immutable scheduler configurations

Routes are split as follows:

- `/` — Svelte SPA through Worker Static Assets
- `/api/*` — Hono Worker API (`GET /api/health`, `POST /api/attempts`)
- `/mcp` — reserved Worker boundary; currently returns `501`

## Local development

Prerequisites: [Bun 1.4.x](https://bun.sh/) and no production Cloudflare credentials.

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars # replace the placeholder with a private random token
bun run cf-types
bun run db:migrate:local
```

Useful commands:

```sh
bun run dev               # Vite UI development server
bun run dev:worker        # build SPA, then serve Worker + local D1 + assets
bun run typecheck
bun run test              # fast Bun domain tests
bun run test:integration  # workerd/Miniflare tests with a real D1 binding
bun run test:all
bun run format:check
bun run build             # Vite build + Wrangler dry-run Worker bundle; does not deploy
```

Wrangler stores local D1 data under `.wrangler/`, which is ignored. No deploy script or CI deploy
is configured.

`POST /api/attempts` is fail-closed and requires
`Authorization: Bearer <ATTEMPT_WRITE_TOKEN>`. Wrangler declares this as a required encrypted
secret; local development reads the private value from `.dev.vars`, while CI uses only a disposable
test value. Health and the reserved MCP boundary do not require this token. Production Cloudflare
Access remains a separate deferred deployment concern rather than being assumed by the Worker.

## Durable learning model

The migrations establish first-class content tables for lexemes, one-to-many readings, tags,
sentences and their lexeme/grammar relations, grammar topics, and content revisions. Learner data
uses activity cards, card state, study sessions, grammar topic state, attempts, FSRS reviews, and
immutable scheduler configurations.

Fresh migrations bootstrap the current scheduler as
`fsrs-6:ts-fsrs@5.4.1:default:0.90:v1`. Its complete deterministic `ts-fsrs` 5.4.1 parameter set
(including disabled fuzz), desired retention, and implementation identity are persisted by the
migration. A scheduled attempt must still carry this exact ID (or another existing immutable
configuration ID); ingestion never substitutes whichever configuration is currently selected.
Every persisted scheduler configuration is append-only immediately, so an ID already issued to an
offline client cannot change or disappear before its first review synchronizes. Selecting a current
configuration may change; optimizing scheduler semantics requires a new configuration ID.

`attempts` is canonical append-only activity history. Only an attempt carrying an intentional FSRS
review gets a 1:1 `fsrs_reviews` row. Canonical replay order is `occurred_at`, then binary
`device_id`, `device_seq`, and `event_id`; server receive order never replaces semantic order.
`card_state` is replaceable derived state with an incrementing version.

Each scheduled ingestion builds the complete per-card state from immutable history, then submits
the attempt, review, server change rows, and version-guarded card-state replacement in one D1
`batch()`. A failed optimistic update is converted into a constraint failure inside that same batch,
so D1 rolls the write set back before the service retries from the new canonical history.

`server_changes.seq` is the monotonic pull-sync cursor. `content_revisions` and
`learner_settings.current_content_revision` establish the matching content revision boundary; the
complete client pull/cache UX is not implemented yet.

## V1 content import

The repository does not vendor the full 595-word dataset or audio. A deterministic importer reads
explicit Git checkouts, records both commit hashes plus a SHA-256 digest of the selected normalized
content in the content revision, separates readings from lexemes, creates representative sentences
and two initial vocabulary card directions, and emits an idempotent SQL file. Consequently, a
partial `--levels`/`--limit` import and a later expanded import produce distinct pull-sync changes,
while an identical rerun does not.

Once revision B supersedes revision A, rerunning A is a content no-op: it cannot rewrite rows or
move `learner_settings.current_content_revision` backward without a new cursor. Within a lexeme,
source readings absent from the newer normalized content are demoted and retired rather than left
active or destructively deleted; current readings are reactivated if they return in a later valid
revision. Import-owned HSK level links are replaced when a lexeme moves level, and generated example
sentences omitted by a newer revision are retired with their active relations removed. An example
is reactivated if a later valid revision restores it.

```sh
bun run import:v1 -- \
  --vocabulary-root /path/to/complete-hsk-vocabulary \
  --v1-root /path/to/why-learn-languages-when-we-have-llms-lol \
  --output .generated/v1-import.sql

bunx wrangler d1 execute chinese-learning --local --file .generated/v1-import.sql
```

Use pinned source checkouts for repeatable output. The importer refuses to read a contributing JSON
path that is modified, deleted, staged differently, or untracked relative to the recorded `HEAD`;
unrelated checkout edits do not affect provenance validation. After migrations and import, new
scheduled cards use the bootstrap scheduler ID documented above. A two-lexeme fixture proves this
fresh setup against D1 without making full content migration part of the test suite. See
[Third-party notices](docs/THIRD_PARTY_NOTICES.md) for provenance and licensing boundaries.

## License

Application code is MIT licensed. Imported or referenced content retains its own source license and
provenance; the project MIT license does not relicense third-party vocabulary or media.
