# Chinese Learning

A locally usable, installable offline PWA for Chinese vocabulary, sentence reading,
beginner grammar, and pronunciation. It imports the complete HSK 2.0 Level 1–3 corpus, caches
bounded study sets in the browser, and records both scheduled FSRS reviews and ordinary practice as
immutable attempts that safely synchronize after temporary network loss.

The reading surface starts with a real Chinese sentence and reveals exact-reading vocabulary hints,
pinyin, meaning, and a linked grammar explanation in that order. The first grammar path covers five
high-value beginner patterns with real examples and a short checked practice interaction. The
pronunciation surface covers pinyin recognition and recall, dictionary-tone identification,
two-syllable tone pairs, source-audio perception where the recording can be mapped safely, and
speak–compare production. Vocabulary separates scheduled free-recall Review from
configurable 4- or 9-choice Quiz practice over introduced material. Quiz adapts only within and
between prepared sessions and never changes vocabulary scheduling. Record combines learner-scoped
recent session summaries with a separate canonical long-term Progress snapshot. See the
[Practice Catalog](docs/practice-catalog.md) for the cross-mode evidence contract. Notion projection,
broad content prefetch, and Remote MCP product surfaces remain deferred.

Canonical learning state is learner-scoped internally while the product remains operationally
single-user: the Worker always resolves the fixed owner learner, with no application login UI,
account chooser, or learner field in browser requests. Private production access is provided by
Cloudflare Access; it is authentication, not a new learner/account model. Shared corpus/card
definitions are not duplicated. See
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
- `/api/*` — Hono Worker API (learner-scoped recent session summaries and long-term progress;
  vocabulary, Quiz, reading, grammar, and pronunciation sessions; and canonical attempts)
- `/mcp` — reserved Worker boundary; currently returns `501`

## Fresh local setup

Prerequisites: [Bun 1.4.x](https://bun.sh/), Git, and no production Cloudflare credentials.

Clone the three content sources outside this repository and pin the revisions used by the
importers. `audio-cmn` remains outside the application repository; only the 480 exactly mapped
files are copied into the ignored local staging directory. Exact-reading recovery also uses the
checked-in normalized SWAC metadata snapshot under `data/pronunciation/`.

```sh
git clone https://github.com/drkameleon/complete-hsk-vocabulary.git /tmp/chinese-learning-complete-hsk-vocabulary
git -C /tmp/chinese-learning-complete-hsk-vocabulary checkout 7ac65bf1a6387d35f1ade478906172a19311c7f9

git clone https://github.com/amatouhake/why-learn-languages-when-we-have-llms-lol.git /tmp/chinese-learning-v1-source
git -C /tmp/chinese-learning-v1-source checkout 6bd4b8dfc45a97fdeca20efeeab0d6d81d236847

git clone --filter=blob:none --sparse https://github.com/hugolpz/audio-cmn.git /tmp/chinese-learning-audio-cmn
git -C /tmp/chinese-learning-audio-cmn sparse-checkout set 64k/hsk README.md
git -C /tmp/chinese-learning-audio-cmn checkout ff9ed3d0c631195bd2c06f39450f3264c7124040
```

The snapshot was generated from the pinned Yue Tan SWAC tag index. To reproduce it after obtaining
the same read-only source artifact, download
`https://fsi-languages.yojik.eu/audiocollections/detailled/cmn-caen-tan/flac/index.tags.txt`,
verify SHA-256
`b6dae2557ee6245d83bb12de1b4ea0ad3b10da9fc25e1e55b206b0c305cd2511`, then run:

```sh
bun run extract:pronunciation-metadata -- \
  --index /tmp/chinese-learning-cmn-caen-tan-index.tags.txt \
  --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
  --audio-root /tmp/chinese-learning-audio-cmn
```

The importer reads the snapshot and pinned checkouts locally; it never fetches the upstream
metadata endpoint. The snapshot records the source URLs, artifact digest, selection revisions,
trusted `SWAC_TEXT`/`SWAC_PRON_PHON` fields, and deterministic extraction method.

Install, migrate a fresh local D1 database, and import the corpus:

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
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
単語, 発音, 読解, and 記録 surfaces. Vocabulary Review starts a bounded session
after the learner chooses 5, 10, or 20 cards and a direction (mixed, Chinese → Japanese meaning,
or Japanese meaning → Chinese). Due cards are selected first, with lexical variety preferred when
the pool allows it; the completed session keeps a local review recap. Answers are staged durably in
IndexedDB and synchronize in the background, so cached practice does not pause on a network round
trip. Vocabulary Quiz lets the learner choose mixed or one of four directions, 4 or 9 choices, and
8, 12, or 20 questions once enough introduced material can supply honest distractors. Reading starts Chinese-first, then
reveals vocabulary, pinyin, meaning, and grammar before recording completion. Its Grammar path
teaches one linked pattern, reveals the example only on request, then checks one bounded completion
exercise and records objective correctness. Pronunciation starts from a
low-friction focus chooser and offers repeatable audio plus a compact sound-system reference. `bun
run dev` serves only the Vite frontend, so use `bun run dev:worker` for the real D1-backed flow and
staged media.

`bun run dev:worker` keeps the local Worker bundle PWA-enabled so offline dogfooding remains
representative. It also marks that bundle as local: the browser bypasses the HTTP cache when
checking the service worker, checks again when the window regains focus, and refreshes a controlled
tab after a new shell activates. Rebuilding and restarting the Worker therefore updates an existing
local tab without clearing browser storage; the deployed build keeps the normal installable PWA
update behavior.

`bun run dev:worker` does not apply D1 migrations. After pulling a branch that adds migrations,
run `bunx wrangler d1 migrations list chinese-learning --local` to inspect the local schema and
then run `bun run db:migrate:local` explicitly before starting the Worker again. This keeps ordinary
development server startup non-mutating.

After the first online study set is prepared, the browser can install the app and continue that
bounded Vocabulary set without a connection, including across reloads. Prepared Quiz, Reading,
Grammar, and Pronunciation sets also work offline. A brand-new Quiz requires a connection so
the server can bind its canonical item and distractor identities; the browser never fabricates an
offline pack. Listening cards are available only when their exact-reading audio was successfully
staged in Cache Storage. An uncached recording is clearly marked and can be skipped without blocking
the rest of the set. Reconnecting the page pushes durable attempts before pulling canonical
learner/content changes. The browser keeps durable device identity separate from learner identity;
canonical ingestion attaches learner ownership from trusted Worker context rather than an offline
event payload.

The checked-in `.dev.vars.example` enables `LOCAL_STUDY_BYPASS=true`. That bypass is accepted only
when the binding is explicitly `true`, the request URL uses a loopback hostname, and the browser
sends a same-origin JSON request (safe GET/HEAD requests are allowed for local health/MCP checks).
Cross-origin and simple-form requests cannot use the bypass. The version-controlled Wrangler
configuration keeps it `false`; production instead requires a signed Cloudflare Access JWT and
the configured owner `sub`. Browser requests send same-origin credentials and no reusable bearer
secret. Wrangler stores ordinary local D1 data under `.wrangler/`, which is ignored.

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

## Private production deployment (owner-gated)

The first production topology is one private Worker with one fresh D1 database and Worker Static
Assets (the current staged media is 480 MP3 files, 4,844,082 bytes / approximately 4.62 MiB;
the largest file is 14,627 bytes):

```text
Cloudflare Access
  -> chinese-learning-production.kenkenhagizou-075.workers.dev
     -> Worker Static Assets (SPA + 480 pronunciation MP3s)
     -> Hono /api/*
     -> authenticated /mcp (501 reservation)
     -> D1 chinese-learning-production
```

Read-only inspection recorded the owner workers.dev subdomain `kenkenhagizou-075`. The Worker, fresh
D1, Access organization/application, and required production secrets are now provisioned; the D1
remains empty until the later migration/import steps. The committed Wrangler configuration omits
`account_id`: Wrangler selects the account from the authenticated session or the optional external
`CLOUDFLARE_ACCOUNT_ID`. The production D1 UUID remains a Git-external operational value, so the
tracked configuration keeps its D1 placeholder and a temporary production config must supply the
real UUID. Access issuer, audience, and owner subject are Worker secrets declared in
`env.production.secrets.required`, never plain vars. The fake local D1 UUID is never copied into
`env.production`.

Cloudflare Access can protect a Worker's production `workers.dev` URL directly, so a custom domain is
not required for this private personal deployment. Create a hostname-based self-hosted application
for the exact workers.dev hostname before the first Worker deployment, or use the Worker-level
Access control immediately when the Worker exists. Permit only the owner. OTP and Google are both
compatible choices; this Worker depends only on the resulting signed Access JWT, not on an IdP SDK.

All remote mutation commands in the sequence below are explicitly marked `DO NOT RUN YET`. They are
documentation for the later owner-approved execution, not commands run by CI or this PR.

### Later owner-approved execution sequence

1. **Local preflight.** Check out this merged baseline/PR, install the frozen lockfile, confirm the
   three pinned source checkouts, and run `bun run check:full`. Confirm `find .generated/public/media
-name '*.mp3' | wc -l` is `480`. Run `bun run check:production:artifacts` after a web build; it
   must report 480 staged and 480 copied MP3 files. Do not proceed if `bun run check:production`
   reports any error.

2. **Enable and configure Access (remote mutation — DO NOT RUN YET).** In Zero Trust, enable the
   organization and choose an IdP. Create a private self-hosted Access application for
   `chinese-learning-production.kenkenhagizou-075.workers.dev`, with a deny-by-default policy and
   one allow rule for the owner. Keep the Access session duration suitable for a personal phone.
   Record the team issuer URL (`https://<team-name>.cloudflareaccess.com`) and the application's
   AUD tag. After the first authorized browser login, obtain the stable Access user ID/`sub` from
   the Access identity view and record it as the owner subject. Provision those three values as
   environment-specific Worker secrets, not `vars`:

   ```sh
   # DO NOT RUN YET — each command creates a new remote Worker version.
   ./node_modules/.bin/wrangler secret put ACCESS_ISSUER --env production
   ./node_modules/.bin/wrangler secret put ACCESS_AUDIENCE --env production
   ./node_modules/.bin/wrangler secret put ACCESS_OWNER_SUB --env production
   ```

   The required names are declared in `env.production.secrets.required`; `wrangler deploy` validates
   that the remote secrets exist before upload. Never put a JWT or secret in the repository, logs,
   `vars`, or a secrets file.

3. **Create the fresh D1 database (remote mutation — DO NOT RUN YET).** The command must name the
   production environment and database explicitly:

   ```sh
   # DO NOT RUN YET — creates a remote D1 database.
   ./node_modules/.bin/wrangler d1 create chinese-learning-production --env production
   ```

   Copy only the returned database UUID into `env.production.d1_databases[0].database_id` in an
   ignored temporary production config. Do not write it into the tracked config. Do not use
   `--update-config` blindly, do not reuse `boardoor-db`, and do not copy the local fake UUID. Run
   `./node_modules/.bin/wrangler d1 info chinese-learning-production --env production` (read-only)
   and confirm the name/UUID before proceeding.

4. **Prepare non-secret production configuration outside Git.** Use a disposable deployment
   worktree or ignored temporary config, keeping the real D1 UUID there only. Leave `account_id`
   absent; authenticated Wrangler or an external `CLOUDFLARE_ACCOUNT_ID` selects the account. Keep
   the three Access values in the remote Worker secrets declared by `secrets.required`, not in
   `vars`. From the temporary worktree, where the temporary file is `wrangler.jsonc`, run:

   ```sh
   bun run cf-types
   bun run check:production -- --config /tmp/chinese-learning-production/wrangler.jsonc
   bun run build:web
   bun run check:production:artifacts
   bun run build:production -- --config /tmp/chinese-learning-production/wrangler.jsonc
   ```

   The production dry run must pass before any remote migration or upload. No Access JWT, API
   token, or browser write secret belongs in `wrangler.jsonc`.

   The default is **A — fresh production learning state**. Do not promote `.wrangler/state` or any
   other local database automatically. Before step 6, the owner must explicitly choose **B —
   migrate trusted local owner history** if that is desired. B requires a separate reviewed export/
   import operation covering the learner-owned `learner_settings`, `card_state`, FSRS reviews,
   grammar state, study sessions, attempts, registered devices, and learner-scoped change rows.
   It must preserve `learner:owner:v1`, every original device/event/session identity and semantic
   occurrence order, and must not duplicate or invent events. This PR intentionally provides no
   history migration command; fresh content bootstrap is the only supported first-deployment path.

5. **Generate deterministic import files locally.** Use the pinned repositories and the existing
   importer contracts, in this order:

   ```sh
   bun run import:v1 -- \
     --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
     --v1-root /tmp/chinese-learning-v1-source \
     --output .generated/v1-import.sql
   bun run import:pronunciation -- \
     --vocabulary-root /tmp/chinese-learning-complete-hsk-vocabulary \
     --audio-root /tmp/chinese-learning-audio-cmn \
     --output .generated/pronunciation-import.sql \
     --media-root .generated/public/media \
     --report .generated/pronunciation-report.json
   bun run check:production:artifacts
   ```

6. **Apply all schema migrations to the fresh D1 (remote mutation — DO NOT RUN YET).** This applies
   migrations `0001` through `0016`, including `0016_pronunciation_mapping_evidence.sql`, before
   any corpus rows are imported:

   ```sh
   # DO NOT RUN YET — applies migrations to the remote production D1.
   ./node_modules/.bin/wrangler d1 migrations apply chinese-learning-production --remote --env production
   ```

   Stop on any migration error. Do not manually mark migrations applied or run `0016` separately.
   For later risky schema work, take a portable export first; the first database is expected to be
   empty so no local learning history is included here.

7. **Record a pre-import recovery point (read-only).** After migrations succeed, inspect the D1
   production version and current Time Travel bookmark:

   ```sh
   ./node_modules/.bin/wrangler d1 info chinese-learning-production --env production
   ./node_modules/.bin/wrangler d1 time-travel info chinese-learning-production --env production
   ```

   Current D1 documentation describes Time Travel as always on for production-backend databases,
   with retention of 7 days on Workers Free and 30 days on Workers Paid. The owner's billing tier
   was not exposed by the read-only account inspection, so the actual retention must be confirmed
   from `d1 info`/the dashboard after creation. Keep the bookmark output private.

8. **Import the full corpus, then pronunciation metadata (remote mutations — DO NOT RUN YET).**
   Each command targets the explicit production name/environment. The first import must be complete
   595-word v1 content; the second depends on the imported 800 readings and adds pronunciation
   metadata, cards, and 480 media mappings:

   ```sh
   # DO NOT RUN YET — mutates the remote production D1.
   ./node_modules/.bin/wrangler d1 execute chinese-learning-production --remote --env production --file .generated/v1-import.sql

   # DO NOT RUN YET — mutates the remote production D1.
   ./node_modules/.bin/wrangler d1 execute chinese-learning-production --remote --env production --file .generated/pronunciation-import.sql
   ```

   If either import fails, stop. Use the bookmark taken immediately before that import for recovery;
   the restore is destructive and must be explicitly approved. Do not improvise cleanup SQL. The
   generated import files are deterministic and idempotent for a corrected rerun after recovery.

9. **Verify the remote corpus read-only.** With the temporary config supplying the real D1 UUID and
   the required Access secrets already provisioned, run:

   ```sh
   bun run verify:production -- --config /tmp/chinese-learning-production/wrangler.jsonc
   ```

   It refuses every environment except `production`, targets `chinese-learning-production`, uses
   `--remote`, and sends one fixed SELECT-only query. It checks 595 lexemes, 800 active readings,
   1,190 scheduled vocabulary cards, 4,141 pronunciation cards, 960 audio cards, 480 media
   mappings, 429 original plus 51 recovered exact mappings, zero invalid mappings/audio gaps, and
   zero pronunciation card state/history. Do not run this command until the owner has created the
   production D1; this planning PR does not run it remotely.

10. **Deploy the Worker (remote mutation — DO NOT RUN YET).** The production build hook repeats the
    configuration and artifact guards before Wrangler uploads anything:

    ```sh
    # DO NOT RUN YET — uploads and activates the production Worker and Static Assets.
    bun run deploy:production
    ```

    The resulting origin is `https://chinese-learning-production.kenkenhagizou-075.workers.dev`.
    Access must already be protecting that hostname. Inspect deployment status (read-only), then
    open the origin in a private browser session. The first unauthenticated request should stop at
    the Access login page; a request with a valid owner session should reach the Worker.

11. **Android/PWA dogfood.** In Android Chrome, authenticate, open the origin, confirm `/api/health`
    and one study session, install the PWA, close/reopen it, prepare a bounded set, and play a
    cached pronunciation recording. Switch offline and verify cached navigation, card answering,
    IndexedDB outbox retention, and Cache Storage audio. Reconnect and verify push-before-pull
    convergence. Let the Access session expire, confirm API errors ask for sign-in rather than
    clearing local state, reauthenticate, and retry sync. The service worker bypasses `/api/*`,
    caches only same-origin shell/media resources, and uses `updateViaCache: "none"` in production;
    a new shell activates on the next normal browser update cycle.

### Production rollback and recovery

- **Worker:** before changing code, record the active deployment/version ID with the dashboard or
  `./node_modules/.bin/wrangler versions list --name chinese-learning-production --env production
--json` (read-only). A rollback creates a new active deployment and does not change D1 or Static
  Assets bindings. If the bad build includes a broken service worker, reopen the origin after the
  rollback, allow the new service worker to activate, and clear only the affected site/PWA cache
  as a last resort; IndexedDB/outbox is application data and should not be cleared casually.
  Rollback itself is a remote mutation:

  ```sh
  # DO NOT RUN YET — replace VERSION_ID with the recorded known-good version.
  ./node_modules/.bin/wrangler rollback VERSION_ID --name chinese-learning-production --env production --message "restore known-good private deployment"
  ```

- **D1:** Worker rollback does not roll back D1. Before future risky migrations, use a private local
  export (read-only remote query plus local file creation):

  ```sh
  ./node_modules/.bin/wrangler d1 export chinese-learning-production --remote --env production --output ./.generated/private-production-backup.sql
  ```

  Confirm the database `version` is `production`; if so, Time Travel can restore within the plan's
  retention window. A restore overwrites the database in place and returns a bookmark for undo, so
  it requires owner approval and a maintenance pause:

  ```sh
  # DO NOT RUN YET — destructive in-place D1 recovery.
  ./node_modules/.bin/wrangler d1 time-travel restore chinese-learning-production --env production --bookmark BOOKMARK
  ```

  Do not assume a Worker rollback repairs a schema or data change. Verify with `bun run
verify:production` after any recovery.

- **Content import:** on a fresh D1, a failed migration/import is an abort point. Restore the
  bookmark from immediately before the failed import (or use the private backup/recovery procedure
  if Time Travel is unavailable), regenerate the same pinned SQL, and rerun only after the local
  guard and source verification pass. The 89 ambiguous and 26 missing source-audio cases are
  intentional and do not block the 480 exact media mappings.

- **Access/PWA:** Access session expiry does not delete IndexedDB or the outbox. `/api/*` is not
  served from the service-worker cache, so a failed authenticated push remains queued. Reauthenticate
  in Chrome/PWA and retry. If a bad shell is installed, use the Worker rollback, wait for
  `service-worker.js` to update, and preserve IndexedDB while removing only stale Cache Storage if
  necessary.

Install the browser binary once with `bun run browser:install` before running `test:browser` or
`check:full`. Browser preparation is rebuilt under `.generated/browser-test`; it does not reuse or
mutate the ordinary local study database under `.wrangler`. The suite starts the real local Worker
and uses Playwright's network simulation to study online, disconnect, queue multiple Vocabulary and
Pronunciation events, reload offline, retry a partial push, reconnect, and verify convergence with
local D1. Phone and desktop coverage also checks the Chinese-first reveal order, the systematic
grammar path, offline Reading and Grammar attempts, reload, and reconnect. The suite additionally
covers multi-tab sequence allocation, legacy-state migration, cached versus uncached audio, a
late-arriving review, a mixed ten-item phone session, the polyphonic `的`, and the two-stage
tone-pair interaction. Quiz dogfood covers phone and desktop layouts, keyboard and touch answers,
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
single-tone cards, 346 exact two-syllable tone-pair cards, 960 audio-perception cards, and 800
production cards: 4,141 non-scheduled cards in total. Of 595 Hanzi-keyed source-audio lookups,
569 have source bytes: 429 retain the conservative single-reading basis, 51 are newly recovered
through exact source pronunciation evidence, 89 remain ambiguous, and 26 are missing. The
pronunciation verifier recreates both imports and a fresh D1 database, verifies every staged audio
file against its pinned Git blob, and locks those coverage counts. Its JSON output gives every
recovered mapping and every unresolved or missing item with a reason. It also reports 141
multi-reading lexemes and 51 cases where the upstream first form is a capitalized proper-name
reading (for example `还` starts with surname `Huán`), so source order is never treated as a
verified beginner-reading choice.

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
the exact staged reveal order and completion, without a comprehension rating. Grammar records the
selected choice and server-derived correctness, without a confidence question. Both append immutable
`attempts` through `POST /api/attempts`; neither creates an `fsrs_reviews` row nor mutates vocabulary
`card_state`. Each Grammar attempt carries the immutable practice-version identity presented in its
cached card, so a delayed offline answer is validated against that historical choice set even after
new teaching content is imported. Grammar additionally materializes the existing
`grammar_topic_state` projection as `introduced`, `learning`, or `comfortable`; new objective practice
does not manufacture a confidence value. Late-arriving events
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

The source audio is named by Hanzi, not reading. The original conservative basis,
`exact_hanzi_filename_single_active_reading`, remains for the 429 legacy mappings. For a
multi-reading lexeme, the importer now additionally requires one source record whose exact
`SWAC_TEXT` is the Hanzi and whose normalized `SWAC_PRON_PHON` matches exactly one active
`lexeme_reading`; this uses the
`exact_source_pronunciation_active_reading` basis. Source pronunciation normalization covers
tone marks/numbers, neutral tone, `ü`/`u:`/`v`, Unicode and separator variants, without tone-sandhi
inference. Zero or multiple canonical matches stay unresolved. The normalized evidence and its
source/artifact digests are stored on the audio-to-reading relationship, while immutable audio
bytes keep the existing `audio-cmn` provenance. Missing or unplayable audio does not block pinyin,
tone, or production prompts; production falls back to a text comparison. Each accepted recording
has a stable media ID derived from the pinned source commit, Hanzi identity, and byte digest.
Cards and attempts reference the exact reading, while the media delivery key is replaceable later,
keeping future R2 hosting outside learning identity.

Every pronunciation activity in this milestone is ordinary, non-FSRS practice:
`hanzi_to_pinyin`, `pinyin_to_hanzi`, `tone_identification`, `tone_pair_identification`,
`audio_to_hanzi`, `audio_to_meaning`, and `pronunciation_production`. Objective activities persist
binary correctness separately from the chosen answer. `hanzi_to_pinyin` persists a separate
self-reported remembered/not-remembered recall fact. New production uses a speak–compare reveal and
persists no correctness or self-rating; old production self-ratings remain historical evidence.
The default mixed focus excludes tone pairs and production, while focused Tone practice presents the
two tone decisions sequentially. None creates an FSRS review or mutates `card_state`. The existing vocabulary directions remain the
only scheduled activities and continue to use Again/Hard/Good/Easy solely as FSRS ratings.
Ordinary attempt history still provides lightweight rotation: least-practiced cards come first,
then the oldest practice, HSK level, and frequency. Non-audio cards retain the single-reading
preference, while an audio card with an exact media join is safe to order by its exact reading
identity even when the lexeme has siblings. A session avoids repeating the same lexeme while
alternatives exist. This keeps new sessions moving through useful beginner material without
turning pronunciation into a scheduler. Unresolved multi-reading lexemes still have no audio
cards, and are never silently collapsed or promoted according to unreliable source ordering.

## Vocabulary Quiz model

The learner-facing Quiz retains the compatible internal `reflex` mode and activates four existing
canonical activities: `hanzi_to_meaning`, `meaning_to_hanzi`, `hanzi_to_pinyin`, and
`pinyin_to_hanzi`. A session can mix them or hold one direction. A lexeme is eligible only after one
of its scheduled vocabulary cards has at least one review. The server prepares a bounded pool for
an 8-, 12-, or 20-answer session and persists the activity, 4/9 choice count, selection strategy,
and exact cards/distractors in `study_sessions.context_json`.
Prepared cards are then cached through the ordinary sync response and IndexedDB stores; there is no
second lexical state, scheduler, history table, or offline queue.

Longer-horizon pool priority is a small score combining under-practice, error rate, slow-response
rate, and trouble within the last seven days. Pool construction takes a high-priority item from each
available activity before deterministic coverage items. Within a session, unseen items receive a
bonus, the latest incorrect or 2.5-second-plus answer receives a larger temporary bonus, each
exposure adds a penalty, and the two most recent cards cool down. Thus troublesome material returns
soon without becoming an immediate loop, while every drill continues to mix other known material.
This is bounded selection, not retention scheduling.

Every question has exactly four or nine stable canonical choice identities. Four choices favor
low-friction repetition; nine increase discrimination but remain a recognition/selection task, not
free recall. Distractors come only from the same activity, never from the target lexeme, and
duplicate normalized labels are removed. A
meaning-to-Hanzi prompt is withheld when its displayed meaning is not unique. Hanzi prompts are
withheld for multi-reading lexemes; pinyin-to-Hanzi prompts prefer the exact reading's sense hint and
are withheld when the same pinyin-plus-meaning prompt is not unique. Choice positions rotate on
repeat exposure, so a learner cannot succeed by memorizing a fixed button.

Each answer appends an ordinary immutable `attempt` with the exact card/lexeme or reading identity,
activity, choice count, objective correctness, presentation ID, round, prompt, hint, correct and
selected choice IDs, and every label in presented order. Response milliseconds are recorded only
when the document remained visible continuously; a visibility interruption records
`timingInterrupted: true` and preserves correctness with `response_ms = NULL`. Ingestion verifies those
facts against the prepared session before accepting them. Duplicate delivery returns the original
fact, device sequences remain unique, and D1 atomically requires the next round while enforcing the
prepared bound. Delayed offline delivery uses the same ordered outbox and canonical push-before-pull
path as every other mode. Quiz attempts cannot carry an FSRS review or expected card-state version,
never create `fsrs_reviews`, and never update due date, stability, difficulty, or vocabulary
`card_state`.

## Practice session summaries and History

`PracticeSessionSummary` is a typed, mode-specific read model derived from learner-owned
`study_sessions.context_json`, immutable `attempts`, `fsrs_reviews`, and relevant content/state.
Raw attempts remain authority; no result table or duplicated event history is created. The local
cache is only an offline projection used to reopen a just-completed result. A generalized presented
result pointer is independent from active session identity, so dismissing a result cannot orphan
canonical closure or delete History.

`POST /api/practice-sessions/recent` returns a bounded learner-scoped list and
`POST /api/practice-sessions/:id/summary` reopens one completed session. Quiz trends require the same
activity setting, choice count, and requested set size. Review ratings are not converted to a score;
Reading records completion without accuracy or a replacement rating; Pronunciation keeps objective
answers, self-reported recall, historical self-ratings, and skips separate. Grammar keeps objective
correctness primary and retains historical confidence separately. `getProgressSnapshot()` remains the
distinct accumulated learner-state projection.

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

All `/api/*` routes and the reserved `/mcp` route pass through one private-auth middleware.
Production accepts only the signed `Cf-Access-Jwt-Assertion` header issued by Cloudflare Access:
`jose` verifies the RS256 signature against the team's rotating JWKS, exact issuer, application
audience, required expiry and subject, and any supplied not-before claim. The Worker then requires
the configured owner `sub` and still resolves all domain operations to `learner:owner:v1`; clients
cannot select a learner. The browser uses same-origin credentials and never sends a bearer token.

The local bypass is deliberately narrower: it requires `LOCAL_STUDY_BYPASS=true`, a loopback URL,
same-origin browser metadata, and JSON for body-bearing requests. A production environment with that
flag enabled returns `auth_unconfigured` and never falls back to a token or identity header. Missing
or invalid Access authentication returns 401, an authenticated non-owner returns 403, and an
incomplete deployment configuration returns 503. Authentication failures do not touch IndexedDB or
the durable outbox. The frontend treats an Access login HTML page or redirect as an auth-expiry
error, rather than trying to parse it as an API response.

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
- pronunciation results per activated activity, keeping objective correctness, self-reported recall,
  historical production self-ratings, and non-answer audio skips separate;
- sentence-reading completion volume without inferred correctness or a replacement rating;
- grammar topic state and objective practice correctness, with historical confidence kept separate;
- Quiz correctness and valid uninterrupted latency/slow-response evidence without feeding FSRS; and
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
Vocabulary, Quiz (`reflex` internally), Reading, Grammar, and Pronunciation packs. An older scheduled attempt that arrives after
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
