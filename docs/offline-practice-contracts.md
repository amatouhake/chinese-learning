# Offline practice contract compatibility

Offline prepared practice has two independent compatibility dimensions:

- `contentRevision` identifies imported learning content. It can change when the corpus or
  pronunciation data changes.
- The practice-contract map identifies the learner-facing interaction and prepared-card shape the
  app understands. It is stored per mode so an unchanged mode does not have to be invalidated by
  another mode's product change.

The current map is:

```text
study          1
reflex         1
pronunciation  2
reading        2
grammar        2
```

Versions are incremented only when an old prepared interaction could no longer be safely rendered
or answered by the new UI. A content import alone does not increment a practice contract. The
legacy map is version `1` for every mode. An omitted wire field or a persisted session/cache record
without a marker is therefore interpreted as legacy, never as implicitly current.

## Stale browser material

On opening `chinese-learning.offline.v1`, the existing IndexedDB metadata and session records are
normalized under the existing browser storage lock. For an unfinished session whose contract is no
longer current, the mode is marked “practice update required” but its unanswered prepared card
rows remain physically present. This protects an already-running older tab that shares the same
database. The new UI gates those rows and never renders or translates them. After pending events
have succeeded, a current-contract pull replaces the unanswered pack atomically; only then are
obsolete rows removed. The session record, completed-item floors, local reviews/answers, attempt
evidence, queued outbox events, card state/FSRS evidence, result pointers, and Cache Storage media
remain throughout.

Pronunciation objective cards also persist the server-generated choice IDs shown for each prepared
card in the existing pronunciation session context. That evidence is append-only for a card:
re-preparing after a content revision cannot overwrite the original set. Delayed attempts are
checked against that immutable presentation evidence, so a valid wrong choice remains ingestible
if a later content revision changes distractors. Sessions prepared before this evidence existed use
the canonical current-set fallback solely for historical compatibility; the client-supplied choice
list is never authoritative.

The localStorage bridge contains no contract field and therefore cannot downgrade or erase the
IndexedDB marker. A sync response that withholds a pack for a stale client likewise leaves the
local mode blocked (or marks an unknown future server version); the marker advances only when a
current-contract pack is accepted locally.

The UI uses one shared Japanese state:

> 練習内容が更新されました。回答済みの内容は保存されています。オンラインに戻ると、新しい形式を準備します。

It never renders or translates stale cards, labels the session completed, or treats the condition as
authentication expiry. Current-contract caches continue to work offline normally.

## Reconnect ordering

Synchronization pushes immutable outbox attempts in device-sequence order first. If any push fails,
the event stays queued and the update-required state stays blocked; no replacement attempt is
created and no stale UI is restored. Only after push outcomes are known does the client pull a
current-contract pack. The same server session ID is retained: the unanswered pack is regenerated
under the current contract, while completed floors and pending-card exclusion prevent an answered
card from being offered again. The local marker advances only when the replacement pack is
actually accepted into IndexedDB.

## Rolling deployment boundary

The sync request carries the per-mode contract map the requesting bundle understands, and the
response carries the server's current map. A client that omits the new field is a known legacy
client. The server withholds incompatible prepared packs and reports the mode mismatch; it does
not send a new card shape to an old UI. An already-running old tab can finish cards it already had
cached, but after reload the new bundle normalizes and blocks stale prepared material. Historical
legacy attempts remain accepted by the ingestion compatibility rules.

There is no D1 migration for this boundary and no IndexedDB database rename or wipe. The existing
database version and stores are retained; only the metadata/session shape is normalized. Valid
media and unrelated current-version practice are not invalidated.
