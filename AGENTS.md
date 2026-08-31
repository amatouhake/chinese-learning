# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/TypeScript offline-first Chinese-learning PWA. `src/web/` contains the Svelte 5 UI,
browser storage, service-worker registration, and API client. `src/worker/` defines the Hono/Cloudflare
Worker boundary; keep business rules in `src/domain/` and D1 queries or import logic in `src/db/`.
Schema changes are ordered SQL files under `migrations/`. Static PWA assets live in `public/`, import
and verification utilities in `scripts/`, and tests in `tests/unit`, `tests/integration`, and
`tests/browser`. Generated `.generated/`, `.wrangler/`, and `dist/` content must not be committed.

## Build, Test, and Development Commands

Use Bun 1.4.x and install with `bun install --frozen-lockfile`.

- `bun run dev` starts only the Vite UI; `bun run dev:worker` serves the real Worker/D1 flow.
- `bun run build` builds Vite and performs a Wrangler dry-run without deploying.
- `bun run check` runs generated-type, format, lint, type, unit, integration, and build gates.
- `bun run test:all` adds isolated Playwright browser coverage; first run
  `bun run browser:install`.
- `bun run db:migrate:local` applies migrations to the local D1 database.

Use repository scripts rather than invoking their underlying tools directly.

## Coding Style & Naming Conventions

Prettier enforces 100-column lines, two-space indentation, semicolons, double quotes, and trailing
commas. Run `bun run format` and `bun run lint`; ESLint rejects floating or misused promises and
non-exhaustive switches. Use `camelCase` for values/functions, `PascalCase` for types and Svelte
components, and kebab-case filenames for domain/DB modules. Keep validation at external boundaries,
use prepared D1 statements, and preserve immutable attempt/event semantics.

## Testing Guidelines

Unit tests use Bun (`*.test.ts`), integration tests use Vitest with Cloudflare/D1 bindings, and
browser tests use Playwright (`*.spec.ts`). Add the narrowest regression test near the affected
layer. There is no numeric coverage threshold; behavior and offline synchronization invariants are
the gate. Run `bun run check` before pushing and `bun run check:full` when corpus, migrations,
ingestion, pronunciation media, or offline browser behavior changes.

## Operational Guardrails

Repository code, migrations, and tests are the authority for exact implemented behavior; architecture
and design documents define intent and constraints. If they disagree, do not silently reconcile them.

Do not deploy or mutate remote Cloudflare/D1 resources, Notion, production secrets, or other external
systems unless the owner explicitly authorizes that operation. Prefer local tooling, dry-runs, and
GitHub-only changes by default.

## Commit & Pull Request Guidelines

Follow the history's imperative Conventional Commit subjects: `feat: add ...`, `fix: preserve ...`,
`test: verify ...`, or `chore: harden ...`. Keep commits focused. Pull requests should explain the
user-visible behavior and data-model impact, list verification commands, link relevant issues, and
include screenshots for UI changes. Call out migrations, offline/sync effects, corpus assumptions,
or generated Cloudflare type changes explicitly; all applicable CI checks must pass.
