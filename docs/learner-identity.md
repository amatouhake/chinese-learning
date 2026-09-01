# Learner identity foundation

The application is multi-user ready internally and single-user operationally. There is no account
surface or production authentication system. Every authorized request currently resolves to the
stable canonical learner ID `learner:owner:v1` in `src/worker/current-learner.ts`; database and
domain services receive that resolved ID explicitly rather than reading an implicit singleton.

## Ownership inventory and model

Before migration `0015`, the database encoded one learner through a singleton
`learner_settings` row, a singleton `projection_state` row, one `card_state` per global card, one
`grammar_topic_state` per global topic, and unowned attempts, sessions, and non-content
`server_changes`. Replay selected every review for a card, progress aggregated every attempt, and
sync pulled every change. Session checks established device ownership but had no parent learner.

The resulting boundary is:

| Scope                 | Canonical data                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared content        | content revisions, lexemes/readings/tags, sentences, grammar content and practice versions, activity types, cards, pronunciation media mappings, scheduler configuration definitions |
| Learner owned         | settings, projection bookkeeping, card/FSRS state, grammar topic state, study sessions, immutable attempts, and non-content change-log rows                                          |
| Device owned          | browser-generated device identity and monotonic `device_seq`; each globally unique device ID is registered to exactly one learner                                                    |
| Global infrastructure | the current imported content revision and global content change-log rows                                                                                                             |

Card definitions remain shared. A new learner receives a fresh state row for every schedulable card,
and a newly imported schedulable card receives a fresh state row for every learner. Composite keys
and foreign keys prevent one learner's state, session, device, or change sequence from being attached
to another learner. Event IDs, session IDs, and device IDs remain globally unique, preserving the
existing offline idempotency contract.

## Request and future authentication boundary

The Worker authorizes the request, resolves the current learner on the server, and passes the learner
ID to every learner-scoped operation. Learning payloads still contain durable device/event/session
identity, but never a selectable learner ID. Supplying an extra `learnerId` field cannot select a
different learner.

A future provider integration should resolve:

```text
provider credential -> provider identity -> canonical learner ID
```

Provider subjects, email addresses, usernames, and Access identities are not learner primary keys.
No provider-identity table is present yet because there is no provider integration to persist. Login,
signup, profiles, account switching, account-local browser migrations, and public registration remain
explicit non-goals.

## Sync and projection semantics

`server_changes.seq` remains one global monotonic sequence. Content rows have `learner_id = NULL` and
are visible to every learner; every attempt, card state, grammar state, and session row has exactly one
learner. Pull captures the global high-water sequence, returns only global content plus the resolved
learner's rows, and advances to the high water when that visible page is exhausted. Changes belonging
to another learner therefore cannot leak or permanently stall a cursor on an invisible sequence gap.

Devices of the same learner pull the same learner-state stream and converge. A device registered to a
different learner pulls a different learner-state stream while sharing content revisions. Offline
events do not carry learner ownership: canonical ingestion attaches the trusted request learner,
checks the device registration, and writes the attempt and its change rows under that learner.

Progress and projection metadata are queried by explicit learner ID. The imported content revision is
kept separately in global `content_state`; timezone remains a learner setting and defaults to
`Asia/Tokyo`.

## FSRS and migration semantics

FSRS materialized state is keyed by `(learner_id, card_id)`. Replay loads immutable reviews by joining
their attempt owner and filters that history before deterministic semantic ordering. An out-of-order
review can rebuild only the matching learner's card state. Scheduler configuration definitions and
the underlying card remain shared and immutable.

Migration `0015_learner_identity_foundation.sql` reconstructs SQLite tables whose keys and foreign
keys change. It seeds the fixed owner, assigns all legacy learner history and state to that owner,
registers every observed legacy device, moves the imported revision to global `content_state`, and
marks only content changes as global. Attempts, FSRS reviews and audit JSON, semantic ordering keys,
session state, server sequences, scheduler references, and projection metadata are copied without
inventing new historical facts. The migration test applies `0001` through `0014`, creates legacy
history, applies `0015`, and checks row preservation plus foreign-key integrity.
