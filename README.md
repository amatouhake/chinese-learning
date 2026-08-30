# Chinese Learning

A locally usable, offline-sync-ready Chinese vocabulary and beginner pronunciation application. It
imports the complete HSK 2.0 Level 1–3 corpus, serves due/new vocabulary through a small Worker API,
and records both scheduled FSRS reviews and ordinary pronunciation practice as immutable attempts.

The pronunciation surface covers pinyin recognition and recall, dictionary-tone identification,
two-syllable tone pairs, source-audio perception where the recording can be mapped safely, and
speak–compare–self-rate production. Reading, grammar, dashboard, Notion projection, offline PWA
media sync, and Remote MCP product surfaces remain deferred.

## Stack and topology

- TypeScript, Bun 1.4.x, Svelte 5, and Vite
- Hono on a Cloudflare Worker
- Worker Static Assets for the SPA
- Cloudflare D1, accessed with prepared SQL and atomic `D1Database.batch()` writes
- `ts-fsrs` 5.4.1 with explicit, immutable scheduler configurations

Routes are split as follows:

- `/` — Svelte SPA through Worker Static Assets
- `/api/*` — Hono Worker API (vocabulary and pronunciation sessions, canonical attempts)
- `/mcp` — reserved Worker boundary; currently returns `501`

## Fresh local setup

Prerequisites: [Bun 1.4.x](https://bun.sh/), Git, and no production Cloudflare credentials.

Clone the three content sources outside this repository and pin the revisions used by the
importers. `audio-cmn` remains outside the application repository; only the 429 conservatively
mapped files are copied into the ignored local staging directory.

```sh
git clone https://github.com/drkameleon/complete-hsk-vocabulary.git /tmp/chinese-learning-complete-hsk-vocabulary
git -C /tmp/chinese-learning-complete-hsk-vocabulary checkout 7ac65bf1a6387d35f1ade478906172a19311c7f9

git clone https://github.com/amatouhake/why-learn-languages-when-we-have-llms-lol.git /tmp/chinese-learning-v1-source
git -C /tmp/chinese-learning-v1-source checkout 6bd4b8dfc45a97fdeca20efeeab0d6d81d236847

git clone --filter=blob:none --sparse https://github.com/hugolpz/audio-cmn.git /tmp/chinese-learning-audio-cmn
git -C /tmp/chinese-learning-audio-cmn sparse-checkout set 64k/hsk README.md
git -C /tmp/chinese-learning-audio-cmn checkout ff9ed3d0c631195bd2c06f39450f3264c7124040
```

Install, migrate a fresh local D1 database, and import the corpus:

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Replace ATTEMPT_WRITE_TOKEN in .dev.vars with a private random local value.
bun run cf-types
bun run db:migrate:local
bun run import:v1 -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --v1-root /tmp/chinese-learning-v1-source \
  --output .generated/v1-import.sql
bunx wrangler d1 execute chinese-learning --local --file .generated/v1-import.sql
bun run import:pronunciation -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --audio-root /tmp/chinese-learning-audio-cmn
bunx wrangler d1 execute chinese-learning --local --file .generated/pronunciation-import.sql
bun run dev:worker
```

Open the loopback URL printed by Wrangler (normally `http://localhost:8787`). The page immediately
offers separate Study and Pronunciation tabs. Vocabulary starts a 10-card session: due cards are
selected first, followed by deterministic new cards. Reveal the answer, rate it with the four FSRS
choices, and continue. Pronunciation starts from a low-friction focus chooser and offers repeatable
audio plus a compact sound-system reference. `bun run dev` serves only the Vite frontend, so use
`bun run dev:worker` for the real D1-backed flow and staged media.

The checked-in `.dev.vars.example` enables `LOCAL_STUDY_BYPASS=true`. That bypass is accepted only
when the binding is explicitly `true`, the request URL uses a loopback hostname, and the browser
sends a same-origin `application/json` request. Cross-origin and simple-form requests cannot use
the bypass. The version-controlled Wrangler configuration keeps it `false`, and production
requests still require the existing bearer token. No credential is included in the frontend bundle.

Wrangler stores ordinary local D1 data under `.wrangler/`, which is ignored. No deploy script or CI
deploy is configured.

## Verification and development commands

```sh
bun run typecheck
bun run test              # fast Bun domain/browser tests
bun run test:integration  # workerd/Miniflare tests with a real D1 binding
bun run test:browser      # bounded phone/desktop dogfood against imported local D1/media
bun run test:all
bun run format:check
bun run cf-types:check
bun run build             # Vite build + Wrangler dry-run Worker bundle; does not deploy
```

Install the browser binary once with
`PLAYWRIGHT_BROWSERS_PATH=.generated/playwright-browsers bunx playwright install chromium` before
running `test:browser`. The browser test starts the real local Worker, completes a mixed ten-item
phone session, verifies staged media responses, checks an exact reading of the polyphonic `的`, and
inspects the complete tone-pair grid and reference at desktop size.

To re-run the exact full-corpus gate against an isolated temporary D1 database (without touching
the app's local study data):

```sh
bun run verify:full-import -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --v1-root /tmp/chinese-learning-v1-source

bun run verify:pronunciation -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --v1-root /tmp/chinese-learning-v1-source \
  --audio-root /tmp/chinese-learning-audio-cmn
```

The pinned corpus produces 595 lexemes (150/147/298 for Levels 1/2/3), 800 active readings, 595
examples, and 1,190 scheduled vocabulary cards with 1,190 initial card states. The verifier also
checks representative vocabulary, the current scheduler, the single content-change marker, and
the commit-plus-content-digest provenance identity.

The pinned pronunciation sources produce 800 exact-reading pinyin cards in each direction, 435
single-tone cards, 346 exact two-syllable tone-pair cards, 858 audio-perception cards, and 800
production cards: 4,039 non-scheduled cards in total. Of 595 Hanzi-keyed source-audio lookups, 429
are reliable, 140 are reading-ambiguous, and 26 are missing. The pronunciation verifier recreates
both imports and a fresh D1 database, verifies every staged audio file against its pinned Git blob,
and locks those coverage counts. Its JSON output lists every ambiguous and missing item for review.
It also reports 141 multi-reading lexemes and 51 cases where the upstream first form is a capitalized
proper-name reading (for example `还` starts with surname `Huán`), so source order is never treated as
a verified beginner-reading choice.

## Pronunciation practice model

Pronunciation content and attempts always identify a concrete `lexeme_reading`. Pinyin, tones,
senses, choices, and media are selected through that reading; a lexeme-level meaning or recording
is never silently borrowed for another pronunciation. Numeric source pinyin accepts both tone `0`
and tone `5` as neutral tone internally, and a tone pair is offered only when exactly two complete
syllable tones can be derived. The UI calls these dictionary tones and gives a brief tone-sandhi
warning rather than pretending to grade connected speech.

The source audio is named by Hanzi, not reading. A recording is therefore mapped only when that
lexeme has exactly one active reading in the imported corpus. A present file for a multi-reading
lexeme is reported as ambiguous and receives neither a media mapping nor audio cards. Missing or
unplayable audio does not block pinyin, tone, or production prompts; production falls back to a
text comparison. Each accepted recording has a stable media ID derived from the pinned source
commit, Hanzi identity, and byte digest. Cards and attempts reference the reading, while the media
delivery key is replaceable later, keeping future R2 hosting outside learning identity.

Every pronunciation activity in this milestone is ordinary, non-FSRS practice:
`hanzi_to_pinyin`, `pinyin_to_hanzi`, `tone_identification`, `tone_pair_identification`,
`audio_to_hanzi`, `audio_to_meaning`, and `pronunciation_production`. Objective activities persist
binary correctness separately from the chosen answer; production persists only a 1–4 self-rating.
None creates an FSRS review or mutates `card_state`. The existing vocabulary directions remain the
only scheduled activities and continue to use Again/Hard/Good/Easy solely as FSRS ratings.
Ordinary attempt history still provides lightweight rotation: least-practiced cards come first,
then the oldest practice, single-reading lexemes, HSK level, and frequency. A session avoids
repeating the same lexeme while alternatives exist. This keeps new sessions moving through useful
beginner material without turning pronunciation into a scheduler. Multi-reading cards remain
available with exact sense hints after the unambiguous foundation rather than being silently
collapsed or promoted according to unreliable source ordering.

## Vocabulary study flow

The study API intentionally exposes no generic database surface:

- `POST /api/study/sessions` creates or idempotently resumes a bounded `study_sessions` row;
- `POST /api/study/sessions/:id/next` returns one canonical vocabulary card plus its exact current
  scheduler configuration ID;
- `POST /api/attempts` remains the only review write path.

A session selects progressed cards whose FSRS state is due before considering new cards. New cards
are card states with zero reviews, ordered by HSK level, frequency, lexeme, and direction. Cards
already reviewed in the current session are excluded, and a session ends after its stored bound or
when no due/new card is available. Both imported directions are independent cards:
`hanzi_to_meaning` and `meaning_to_hanzi`.

The reveal-and-rate interaction deliberately leaves `attempts.correct` and `self_rating` null. The
chosen Again/Hard/Good/Easy value is persisted only as the FSRS rating, preserving the existing
correctness-versus-scheduler distinction. The response contains the resulting materialized card
state, and the next-card query observes canonical D1 state.

The browser keeps one small versioned localStorage record containing its stable device ID, the next
device sequence, active session ID, and at most one pending attempt. Staging a review durably saves
the complete event and advances the next sequence before any request is sent. Reloading retries the
same event ID/sequence until the idempotent server acknowledges it; it never silently replaces a
corrupt identity. Browser-wide Web Locks serialize every read-modify-write transaction so two tabs
cannot reserve the same device sequence or clear each other's pending event. Staging also compares
the tab's sequence and pending-event snapshot with durable state, rejecting a card left stale by a
review in another tab. Browsers without that coordination primitive fail closed. This is a
deliberately small single-outbox boundary for this online slice. The later PWA work can move content
and a multi-event queue to IndexedDB without changing the canonical event contract.

`POST /api/attempts` remains fail-closed and accepts
`Authorization: Bearer <ATTEMPT_WRITE_TOKEN>` outside the explicit loopback-only development mode.
Wrangler declares the token as a required encrypted secret; local development reads the private
value from `.dev.vars`, while tests use only a disposable binding. Production Cloudflare Access
remains a separate deferred deployment concern rather than being assumed by the Worker.

## Durable learning model

The migrations establish first-class content tables for lexemes, one-to-many readings, tags,
sentences and their lexeme/grammar relations, grammar topics, and content revisions. Learner data
uses activity cards, card state, study sessions, grammar topic state, attempts, FSRS reviews, and
immutable scheduler configurations.

Fresh migrations bootstrap the current scheduler as
`fsrs-6:ts-fsrs@5.4.1:default:0.90:v1`. Its complete deterministic `ts-fsrs` 5.4.1 parameter set
(including disabled fuzz), desired retention, and implementation identity are persisted by the
migration. A scheduled attempt must carry this exact ID (or another existing immutable
configuration ID); ingestion never substitutes whichever configuration is current when the event
arrives. Every scheduler configuration is append-only immediately, and changing scheduler
semantics requires a new configuration ID.

`attempts` is canonical append-only activity history. Only an attempt carrying an intentional FSRS
review gets a 1:1 `fsrs_reviews` row. Canonical replay order is `occurred_at`, then binary
`device_id`, `device_seq`, and `event_id`; server receive order never replaces semantic order.
`card_state` is replaceable derived state with an incrementing version. Attempts associated with a
study session must carry that session's owning device identity.

Each scheduled ingestion rebuilds the complete per-card state from immutable history, then submits
the attempt, review, server change rows, and version-guarded state replacement in one D1 `batch()`.
A failed optimistic update becomes a constraint failure inside the same batch, so D1 rolls the
write set back before the service retries from canonical history.

`server_changes.seq` is the monotonic pull-sync cursor. `content_revisions` and
`learner_settings.current_content_revision` establish the matching content revision boundary; the
complete client pull/cache UX is not implemented yet.

## V1 content import

The repository does not vendor the full 595-word dataset or audio. A deterministic importer reads
explicit Git checkouts, records both commit hashes plus a SHA-256 digest of normalized content,
separates readings from lexemes, creates representative sentences and two vocabulary card
directions, and emits an idempotent SQL file. Duplicate lexeme/enrichment identities and unsupported
CLI options are rejected before revision hashing or SQL generation.

A partial `--levels`/`--limit` import and a later expanded import produce distinct pull-sync changes,
while an identical rerun is a complete database no-op even if its non-identity creation timestamp
differs. Once revision B supersedes revision A, rerunning A cannot rewrite rows or move the current
content revision backward. Removed source readings/examples are retired, and restored content can
be reactivated without destructive deletion.

Every contributing JSON path must be tracked at the recorded `HEAD`; the importer compares its
exact worktree bytes with the commit and refuses modified, deleted, staged-different, untracked, or
index-hidden inputs. Unrelated checkout edits do not affect provenance validation. After import,
new cards use the bootstrap scheduler ID documented above. Small fixtures keep the regular
workerd suite fast; `verify:full-import` is the reproducible real 595-word fresh-D1 gate. See
[Third-party notices](docs/THIRD_PARTY_NOTICES.md) for provenance and licensing boundaries.

## License

Application code is MIT licensed. Imported or referenced content retains its own source license and
provenance; the project MIT license does not relicense third-party vocabulary or media.
