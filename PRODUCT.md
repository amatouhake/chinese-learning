# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a beginner-to-intermediate Chinese learner using a private,
installable PWA for a short daily practice ritual, usually on a phone and sometimes
on a desktop keyboard. The learner-facing interface is Japanese-first; Chinese is the
material being learned, while English may remain only in content provenance or a safe
fallback meaning. The user wants to answer quickly, notice mistakes immediately, and
return to difficult material without managing a complex study system.

The running product intentionally has one operational owner learner. Canonical persistence is
learner-scoped internally so future authenticated learners can share corpus definitions without
sharing learning state, but account UX and production authentication are not current product
capabilities.

## Product Purpose

Chinese Learning is an offline-first daily training tool for vocabulary review and quizzes,
sentence reading, beginner grammar, and pronunciation. It makes a small, reliable
practice loop available even when the network is unavailable, then synchronizes the
same immutable learning events when the connection returns. Success is a learner who
can open the app, complete a useful bounded session with low friction, and trust that
their history and scheduling remain intact.

## Positioning

The product joins scheduled vocabulary review and unscheduled multiple-choice practice, reading,
grammar, and pronunciation practice around one canonical exact-reading content model.
It is intentionally conservative about pronunciation media and resilient to offline
use: a recording is never borrowed across readings, and a delayed answer still
converges deterministically with canonical D1 state.

## Operating Context

Daily use is a short sequence of touch-first drills on a common phone viewport, with
keyboard answers useful on desktop. The compact Japanese-first shell names four surfaces:
単語, 発音, 読解, and 記録. 単語 separates due-before-new free-recall 復習 from a configurable
4択/9択 クイズ over introduced material. 発音, 読解, and 文法 remain ordinary practice.
記録 separates recent session history from accumulated long-term progress. The learner may lose
the network, reload, or reopen the installed PWA between answers.

## Capabilities and Constraints

- Svelte 5 and Vite provide the browser UI; Hono and Cloudflare D1 provide the worker
  boundary and canonical state.
- The app imports the pinned HSK 2.0 Levels 1–3 corpus and the pinned pronunciation
  source. Local media is staged and served through the PWA; remote fonts and decorative
  assets must not be runtime requirements.
- Vocabulary Review uses immutable attempts and FSRS scheduling. Vocabulary Quiz, pronunciation,
  reading, and grammar remain separate ordinary-practice modes and must not mutate
  vocabulary card state unless the existing canonical contract says so.
- Exact Hanzi-reading identity, deterministic late-event convergence, IndexedDB outbox
  synchronization, D1 canonical state, content provenance, and migration behavior are
  product constraints, not implementation details to trade away for UI simplicity.
- Learner ownership is resolved by the trusted server boundary. Devices remain separate children of
  a learner; browser payloads cannot select another learner. FSRS state, attempts, sessions, grammar
  state, settings, progress, projections, and learner sync changes must remain isolated.
- Login, signup, profiles, account switching, provider authentication, and public registration are
  explicitly deferred. A future provider identity must resolve to the stable canonical Learner
  identity rather than become the domain primary key.
- Active drill states should fit the prompt, choices, feedback, and progression into
  one viewport at common 320px and 390px phone widths without routine page scrolling.
- Touch targets must be comfortable; desktop keyboard shortcuts remain effective;
  correctness must be legible without relying on color alone; sound is user-controlled
  and its preference persists locally.
- Reliable exact-reading pronunciation media may appear in everyday Vocabulary Review and
  Quiz practice. Ambiguous, missing, uncached, or unplayable media degrades safely and
  never becomes a verified pronunciation claim.

## Brand Commitments

The product name is Chinese Learning and its short Chinese mark is 中文学习. The owner
explicitly wants a finished, beautiful, frequently used Chinese study instrument rather
than a generic dashboard. The visual direction is intentionally open for the redesign;
the current beige/green implementation is not a target identity.

## Evidence on Hand

- `README.md` documents the current architecture, corpus provenance, learning model,
  offline behavior, and verification commands.
- `src/domain/` and `src/db/` are the authority for learning semantics, exact-reading
  identity, pronunciation mapping, and canonical progress.
- `src/web/` is the current runnable Svelte surface and its browser tests under
  `tests/browser/` exercise phone, desktop, offline, reload, reconnect, and media paths.
- The pinned predecessor at commit `6bd4b8dfc45a97fdeca20efeeab0d6d81d236847` in
  `why-learn-languages-when-we-have-llms-lol` is an interaction reference only.

## Product Principles

- Make the next answer obvious.
- Keep daily practice bounded, fast, and satisfying.
- Preserve the learner's exact history rather than rewriting it for convenience.
- Let sound and visual feedback reinforce one another without blocking progress.
- Prefer honest graceful degradation to invented certainty.

## Accessibility & Inclusion

The UI must remain usable at a 320px-wide viewport, support touch and keyboard input,
provide visible focus states and semantic live feedback, respect reduced-motion
preferences, and never make sound the only channel for correctness or progression.
