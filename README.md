# Chinese Learning

A locally usable, installable offline PWA for Chinese vocabulary, automaticity, sentence reading,
beginner grammar, and pronunciation. It imports the complete HSK 2.0 Level 1–3 corpus, caches
bounded study sets in the browser, and records both scheduled FSRS reviews and ordinary practice as
immutable attempts that safely synchronize after temporary network loss.

The reading surface starts with a real Chinese sentence and reveals exact-reading vocabulary hints,
pinyin, meaning, and a linked grammar explanation in that order. The first grammar path covers five
high-value beginner patterns with real examples and a short checked practice interaction. The
pronunciation surface covers pinyin recognition and recall, dictionary-tone identification,
two-syllable tone pairs, source-audio perception where the recording can be mapped safely, and
speak–compare–self-rate production. Reflex provides short four-choice retrieval drills over already
introduced material, adapting only within and between Reflex sessions without changing vocabulary
scheduling. A local Progress dashboard now summarizes all five learning modes from one canonical,
read-only D1 progress snapshot. Notion projection, broad content prefetch, and Remote MCP product
surfaces remain deferred.

Canonical learning state is learner-scoped internally while the product remains operationally
single-user: the Worker always resolves the fixed owner learner, with no login, account chooser, or
learner field in browser requests. Shared corpus/card definitions are not duplicated. See
[Learner identity foundation](docs/learner-identity.md) for the ownership, sync, migration, and future
authentication boundary.

## Stack and topology

- TypeScript, Bun 1.4.x, Svelte 5, and Vite
- Hono on a Cloudflare Worker
- Worker Static Assets for the SPA
- Cloudflare D1, accessed with prepared SQL and atomic `D1Database.batch()` writes
- `ts-fsrs` 5.4.1 with explicit, immutable scheduler configurations
- A canonical internal Learner identity resolved server-side to the fixed owner for the current
  private/local product

Routes are split as follows:

- `/` — Svelte SPA through Worker Static Assets
- `/api/*` — Hono Worker API (the read-only progress snapshot; vocabulary, Reflex, reading, grammar,
  and pronunciation sessions; and canonical attempts)
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
bun run db:execute:local -- --file .generated/v1-import.sql
bun run import:pronunciation -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --audio-root /tmp/chinese-learning-audio-cmn
bun run db:execute:local -- --file .generated/pronunciation-import.sql
bun run dev:worker
```

Open the loopback URL printed by Wrangler (normally `http://localhost:8787`). The page offers
Progress, Study, Reflex, Reading, and Pronunciation surfaces. Vocabulary starts a bounded session
after the learner chooses 5, 10, or 20 cards and a direction (mixed, Chinese → Japanese meaning,
or Japanese meaning → Chinese). Due cards are selected first, with lexical variety preferred when
the pool allows it; the completed session keeps a local review recap. Answers are staged durably in
IndexedDB and synchronize in the background, so cached practice does not pause on a network round
trip. Reflex starts a 12-answer automaticity drill
once enough introduced material can supply honest distractors. Reading starts Chinese-first, then
reveals vocabulary, pinyin, meaning, and grammar before accepting a 1–4 comprehension rating. Its
Grammar path teaches one linked pattern, reveals the example only on request, then checks one
bounded completion exercise and records explicit confidence. Pronunciation starts from a
low-friction focus chooser and offers repeatable audio plus a compact sound-system reference. `bun
run dev` serves only the Vite frontend, so use `bun run dev:worker` for the real D1-backed flow and
staged media.

`bun run dev:worker` keeps the local Worker bundle PWA-enabled so offline dogfooding remains
representative. It also marks that bundle as local: the browser bypasses the HTTP cache when
checking the service worker, checks again when the window regains focus, and refreshes a controlled
tab after a new shell activates. Rebuilding and restarting the Worker therefore updates an existing
local tab without clearing browser storage; the deployed build keeps the normal installable PWA
update behavior.

After the first online study set is prepared, the browser can install the app and continue that
bounded Vocabulary set without a connection, including across reloads. Prepared Reflex, Reading,
Grammar, and Pronunciation sets also work offline. A brand-new Reflex drill requires a connection so
the server can bind its canonical item and distractor identities; the browser never fabricates an
offline pack. Listening cards are available only when their exact-reading audio was successfully
staged in Cache Storage. An uncached recording is clearly marked and can be skipped without blocking
the rest of the set. Reconnecting the page pushes durable attempts before pulling canonical
learner/content changes. The browser keeps durable device identity separate from learner identity;
canonical ingestion attaches learner ownership from trusted Worker context rather than an offline
event payload.

The checked-in `.dev.vars.example` enables `LOCAL_STUDY_BYPASS=true`. That bypass is accepted only
when the binding is explicitly `true`, the request URL uses a loopback hostname, and the browser
sends a same-origin `application/json` request. Cross-origin and simple-form requests cannot use
the bypass. The version-controlled Wrangler configuration keeps it `false`, and production
requests still require the existing bearer token. No credential is included in the frontend bundle.

Wrangler stores ordinary local D1 data under `.wrangler/`, which is ignored. No deploy script or CI
deploy is configured.

## Verification and development commands

The repository tooling contract is Prettier for formatting, ESLint for JS/TS/Svelte defect
checking, `svelte-check` plus TypeScript for compiler correctness, and project scripts for all test
and build gates. Use the scripts instead of invoking their underlying tools directly.

```sh
bun run format           # rewrite supported files with Prettier
bun run format:check     # verify formatting without writes
bun run lint             # ESLint recommended JS/TS/Svelte rules
bun run lint:fix         # apply safe ESLint fixes
bun run typecheck
bun run test              # alias for the fast Bun unit suite
bun run test:unit
bun run test:integration  # workerd/Miniflare tests with a real D1 binding
bun run test:browser      # prepare isolated D1/media, then run phone/desktop Playwright dogfood
bun run test:all          # unit + integration + browser
bun run cf-types:check
bun run build             # Vite build + Wrangler dry-run Worker bundle; does not deploy
bun run verify:corpus
bun run verify:pronunciation
bun run check             # normal source-only correctness gate
bun run check:full        # check + both corpus verifiers + isolated browser dogfood
```

`bun run check` verifies generated Worker types, formatting, linting, types, unit and workerd/D1
integration tests, the production Vite build, and the Wrangler dry run. It needs only the repository
and its frozen dependencies, so it is the normal pre-push gate. `bun run check:full` additionally
recreates both corpus imports, verifies pronunciation media, prepares an isolated browser-test D1
database, and runs Playwright. It expects the three pinned source checkouts from Fresh local setup at
their documented `/tmp/chinese-learning-*` paths. Each corpus or browser command also accepts the
corresponding `--vocabulary-root`, `--v1-root`, and `--audio-root` overrides.

Install the browser binary once with `bun run browser:install` before running `test:browser` or
`check:full`. Browser preparation is rebuilt under `.generated/browser-test`; it does not reuse or
mutate the ordinary local study database under `.wrangler`. The suite starts the real local Worker
and uses Playwright's network simulation to study online, disconnect, queue multiple Vocabulary and
Pronunciation events, reload offline, retry a partial push, reconnect, and verify convergence with
local D1. Phone and desktop coverage also checks the Chinese-first reveal order, the systematic
grammar path, offline Reading and Grammar attempts, reload, and reconnect. The suite additionally
covers multi-tab sequence allocation, legacy-state migration, cached versus uncached audio, a
late-arriving review, a mixed ten-item phone session, the polyphonic `的`, and the tone-pair
reference. Reflex dogfood covers phone and desktop layouts, keyboard and touch answers,
correct/incorrect/slow responses, adaptive repeats, option-position rotation, session restart,
offline reload/reconnect, duplicate retry, and the absence of scheduler projection changes.

To re-run the exact full-corpus gate against an isolated temporary D1 database (without touching
the app's local study data):

```sh
bun run verify:corpus -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --v1-root /tmp/chinese-learning-v1-source

bun run verify:pronunciation -- \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --v1-root /tmp/chinese-learning-v1-source \
  --audio-root /tmp/chinese-learning-audio-cmn
```

Those root arguments are optional when the checkouts use the documented `/tmp` paths.

GitHub Actions exposes three merge-facing checks. `Quality` runs `bun install --frozen-lockfile`
and `bun run check`. `Browser` runs on pull requests after `Quality`, checks out the pinned sources,
installs the lockfile-pinned Chromium build, and runs the isolated Playwright command. `Corpus
integrity` runs both complete verifiers whenever corpus, ingestion, migrations, validation tooling,
or dependency inputs change; otherwise it records an intentional successful skip. A weekly schedule
and manual dispatch run the full corpus job regardless of changed paths. All jobs use read-only
repository permissions and have bounded timeouts; no CI job deploys or accesses production D1.

The pinned corpus produces 595 lexemes (150/147/298 for Levels 1/2/3), 800 active readings, 595
examples, and 1,190 scheduled vocabulary cards with 1,190 initial card states. Five verified
examples are activated as sentence-reading cards and linked to five grammar-topic cards through 18
exact lexeme-reading annotations. Five immutable grammar-practice versions bind cached exercises to
their presented answers. The verifier also checks representative vocabulary, grammar and reading
links, the current scheduler, the single content-change marker, and the
commit-plus-content-digest provenance identity.

The pinned pronunciation sources produce 800 exact-reading pinyin cards in each direction, 435
single-tone cards, 346 exact two-syllable tone-pair cards, 858 audio-perception cards, and 800
production cards: 4,039 non-scheduled cards in total. Of 595 Hanzi-keyed source-audio lookups, 429
are reliable, 140 are reading-ambiguous, and 26 are missing. The pronunciation verifier recreates
both imports and a fresh D1 database, verifies every staged audio file against its pinned Git blob,
and locks those coverage counts. Its JSON output lists every ambiguous and missing item for review.
It also reports 141 multi-reading lexemes and 51 cases where the upstream first form is a capitalized
proper-name reading (for example `还` starts with surname `Huán`), so source order is never treated as
a verified beginner-reading choice.

## Reading and grammar model

Reading uses five concise examples already present in the pinned imported corpus: `我是学生。`,
`我有两个姐姐。`, `我在家。`, `我不喝咖啡。`, and `你好吗？`. The importer fails closed if the
Chinese, pinyin, Japanese meaning, or English meaning of an expected example drifts. Each displayed
vocabulary hint points to a concrete `lexeme_reading`, not merely a Hanzi string, and keeps its token
position and learner-facing role. Sentence-to-topic links use the existing relational model.

The systematic grammar path is `是` noun linking, `有` possession/existence, `在` location, `不`
habitual negation, then `吗` yes/no questions. This is intentionally a narrow beginner foundation:
each topic has an original Japanese explanation, pattern and contrast note, one real linked example,
and one server-checked multiple-choice completion. It reinforces the same sentences instead of
introducing a parallel textbook or authoring system.

Reading and Grammar both use the existing non-scheduled `sentence_reading` activity. Reading records
the exact staged reveal order and an explicit 1–4 comprehension rating. Grammar records the selected
choice, server-derived correctness, and an explicit 1–4 confidence rating. Both append immutable
`attempts` through `POST /api/attempts`; neither creates an `fsrs_reviews` row nor mutates vocabulary
`card_state`. Each Grammar attempt carries the immutable practice-version identity presented in its
cached card, so a delayed offline answer is validated against that historical choice set even after
new teaching content is imported. Grammar additionally materializes the existing
`grammar_topic_state` projection as `introduced`, `learning`, or `comfortable`. Late-arriving events
remain immutable, while that durable projection follows canonical semantic event order rather than
network receive order.

Reading and Grammar sessions and their bounded packs use the same IndexedDB, device sequence,
outbox, push-before-pull synchronization, and `server_changes` cursor as the existing surfaces. The
currently prepared content remains usable through temporary network loss and reload. No parallel
history or synchronization channel exists.

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

## Reflex automaticity model

Reflex activates four existing canonical activities: `hanzi_to_meaning`, `meaning_to_hanzi`,
`hanzi_to_pinyin`, and `pinyin_to_hanzi`. A lexeme is eligible only after one of its scheduled
vocabulary cards has at least one review. The server prepares an eight-item pool for a bounded
12-answer session and persists that exact pool in the existing `study_sessions.context_json`.
Prepared cards are then cached through the ordinary sync response and IndexedDB stores; there is no
second lexical state, scheduler, history table, or offline queue.

Longer-horizon pool priority is a small score combining under-practice, error rate, slow-response
rate, and trouble within the last seven days. Pool construction takes a high-priority item from each
available activity before deterministic coverage items. Within a session, unseen items receive a
bonus, the latest incorrect or 2.5-second-plus answer receives a larger temporary bonus, each
exposure adds a penalty, and the two most recent cards cool down. Thus troublesome material returns
soon without becoming an immediate loop, while every drill continues to mix other known material.
This is bounded selection, not retention scheduling.

Every question has exactly four stable canonical choice identities. Distractors come only from the
same activity, never from the target lexeme, and duplicate normalized labels are removed. A
meaning-to-Hanzi prompt is withheld when its displayed meaning is not unique. Hanzi prompts are
withheld for multi-reading lexemes; pinyin-to-Hanzi prompts prefer the exact reading's sense hint and
are withheld when the same pinyin-plus-meaning prompt is not unique. Choice positions rotate on
repeat exposure, so a learner cannot succeed by memorizing a fixed button.

Each answer appends an ordinary immutable `attempt` with the exact card/lexeme or reading identity,
activity, objective correctness, response milliseconds, presentation ID, round, prompt, hint,
correct and selected choice IDs, and the four labels in presented order. Ingestion verifies those
facts against the prepared session before accepting them. Duplicate delivery returns the original
fact, device sequences remain unique, and D1 atomically requires the next round while enforcing the
prepared bound. Delayed offline delivery uses the same ordered outbox and canonical push-before-pull
path as every other mode. Reflex attempts cannot carry an FSRS review or expected card-state version,
never create `fsrs_reviews`, and never update due date, stability, difficulty, or vocabulary
`card_state`.

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

IndexedDB is the canonical browser store for the stable device identity, monotonic next device
sequence, active sessions, bounded study cards, materialized card states, synchronization cursor,
content revision, and a multi-event outbox. Staging an answer atomically saves the complete immutable
event, consumes its cached card, and advances the device sequence before any request is sent. Every
event retains its original event/device identity, occurrence time, FSRS rating, and exact scheduler
configuration while queued. Reloading or reopening retries those same facts until the idempotent
server acknowledges each event; a partial push deletes only acknowledgements already received.

Browser-wide Web Locks serialize IndexedDB writes and synchronization. Two tabs therefore cannot
reserve the same device sequence, overwrite an outbox entry, or answer the same stale cached card.
A stale tab fails closed and reloads current durable state. Browsers without Web Locks also fail
closed. A small localStorage identity mirror is only a recovery watermark; it is not the learning
cache. On first open, browser state versions 1–3 are migrated once from the previous localStorage
record into IndexedDB. The existing `device_id`, next unused `device_seq`, active session/focus, and
single pending event are preserved. Sequence allocation takes the maximum durable watermark so a
database recovery never deliberately reuses an issued sequence.

Reconnect synchronization pushes the outbox in device-sequence order, then pages canonical changes
after the stored `server_changes.seq` cursor. Learner changes and content-revision changes remain
separate in the response. Pulled `card_state` replaces only the local derived projection; immutable
history is never resolved with last-write-wins. The server returns fresh bounded packs for active
sessions, and pending card IDs are filtered before replacement so a pull cannot resurrect work
staged concurrently. Pronunciation media for the available pack is explicitly staged in a dedicated
Cache Storage cache rather than being added by a generic runtime media cache.

`POST /api/attempts` remains fail-closed and accepts
`Authorization: Bearer <ATTEMPT_WRITE_TOKEN>` outside the explicit loopback-only development mode.
Wrangler declares the token as a required encrypted secret; local development reads the private
value from `.dev.vars`, while tests use only a disposable binding. Production Cloudflare Access
remains a separate deferred deployment concern rather than being assumed by the Worker.

## Local progress read model

`getProgressSnapshot()` in `src/db/progress.ts` is the canonical domain aggregation used by the
local dashboard and reserved for later Notion/MCP consumers. `POST /api/progress` exposes that same
snapshot through the existing authenticated local-study boundary; the POST transport exists only
to reuse the loopback request guard and performs no writes.

The version-1 snapshot includes:

- generated time, highest included `server_changes.seq`, latest server change/attempt receipt, latest
  semantic attempt occurrence, projection version, and learner timezone;
- rolling 7/30-day attempt, answer, scheduled-review, active-day, session, and per-mode volume;
- current scheduled vocabulary counts plus recent FSRS ratings and cards with recent Again/Hard or
  lifetime lapse evidence;
- pronunciation results per activated activity, keeping objective correctness, production
  self-ratings, and non-answer audio skips separate;
- sentence-reading volume and comprehension self-ratings without inferred correctness;
- grammar topic state, objective practice correctness, and confidence as separate measures;
- Reflex correctness and latency/slow-response evidence without feeding FSRS; and
- a deterministic, bounded cross-mode trouble list whose reasons and source activity remain visible.

Rolling activity windows are selected by `attempts.occurred_at`. Active calendar days are formatted
in the configured learner IANA timezone (`Asia/Tokyo` by default). Freshness/data-through metadata
uses canonical server ingestion boundaries (`server_changes.seq`/`changed_at` and
`attempts.received_at`), so a delayed offline event refreshes the boundary without being moved into
the wrong study window. The read path issues one constant-size D1 batch of set-oriented queries; an
occurrence-time index bounds recent-history scans. It creates no analytics facts, cache rows,
attempts, reviews, sessions, or state updates.

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
`card_state` is replaceable learner-owned derived state with an incrementing version. Attempts
associated with a study session must carry that session's learner and owning device identity.

Each scheduled ingestion rebuilds that learner's complete per-card state from immutable history,
then submits
the attempt, review, server change rows, and version-guarded state replacement in one D1 `batch()`.
A failed optimistic update becomes a constraint failure inside the same batch, so D1 rolls the
write set back before the service retries from canonical history.

`server_changes.seq` is the monotonic pull-sync cursor. `content_revisions` and global
`content_state.current_content_revision` establish the distinct content revision boundary.
`POST /api/sync/pull` reports both boundaries, filters learner changes by the server-resolved learner,
and supplies only that learner's current active sessions' bounded
Vocabulary, Reflex, Reading, Grammar, and Pronunciation packs. An older scheduled attempt that arrives after
a newer review is inserted as its original immutable fact; the existing deterministic server replay
recomputes the canonical `card_state`, which the next pull applies locally.

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
