# Practice Catalog and session evidence

This catalog is the semantic contract between domain code, D1 session history, and learner-facing
setup/result copy. `src/domain/practice-catalog.ts` is the executable copy authority. Active drills
remain deliberately sparse; purpose and evidence descriptions belong on setup or compact help
surfaces.

| Practice     | Internal identity | Purpose and interaction                                                                                 | Recorded evidence                                                                  | Intentionally not measured                                          | FSRS | Use it when                                           |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| 単語・復習   | `study`           | Free recall, then reveal and rate the recall                                                            | immutable attempt, due/new source, direction, FSRS rating                          | multiple-choice accuracy or automaticity                            | Yes  | retaining vocabulary over time                        |
| 単語・クイズ | `reflex`          | Objective 4- or 9-choice recognition/retrieval                                                          | activity, choice count, correctness, valid uninterrupted latency                   | free recall or long-term retention                                  | No   | making introduced words faster and easier to identify |
| 発音         | `pronunciation`   | Mixed low-friction listening, reading, and tone practice; focused two-stage tone pairs or speak-compare | focus, activity, objective correctness, self-reported recall, completed practice   | one synthetic pronunciation score or automatic speech grade         | No   | connecting exact readings, sound, and production      |
| 読解         | `reading`         | Staged sentence reading, then completion                                                                | completed sentence, grammar topics encountered; old self-ratings remain historical | fabricated objective accuracy or replacement rating                 | No   | understanding vocabulary and grammar in context       |
| 読解・文法   | `grammar`         | Topic explanation, examples, objective choice, feedback, then completion                                | topic, objective correctness; old confidence remains historical                    | free composition, confidence requirement, or combined reading score | No   | checking a grammar pattern and its discrimination     |

## Review and Quiz are different evidence

Vocabulary Review is due-before-new free recall. Its four ratings are scheduling evidence, not a
traditional score. Vocabulary Quiz is ordinary practice over introduced material and never updates
FSRS. Four choices reduce friction and suit fast repetition. Nine choices increase discrimination
among alternatives, but remain a recognition/selection task; neither configuration is “true
recall.” Quiz trends therefore compare only the same activity, choice count, and requested set size.
Adaptive candidate history is likewise scoped by choice count; missing choice-count metadata from the
released four-choice Reflex interaction is interpreted as 4択 evidence. Nine-choice latency remains
valid same-configuration evidence, but it is not classified with the old 2.5-second four-choice
“slow” threshold. Incorrect answers remain weak evidence for both configurations.

## Historical configuration

`study_sessions.context_json` is the immutable prepared-session configuration. Typed mode-specific
contracts own its fields. Current browser preferences only seed a new session and must never be used
to explain an existing session. The prepared Quiz card pool and distractor set live in the Reflex
context so reload and offline use reproduce the same session.

`attempts` and `fsrs_reviews` remain the raw authority. `aggregate_json` is a closure snapshot for
operational inspection and may be recomputed; learner-facing `PracticeSessionSummary` values are a
read model derived from session context plus immutable attempts and mode-specific evidence. A
bounded localStorage history projection may preserve that derived read model for offline reopening,
while IndexedDB retains prepared sessions and attempts used to rebuild newly completed results.
Neither is a second event history; canonical learner-scoped reads replace matching local projections
after synchronization.

## Timing

Quiz latency is valid only while the question remains continuously visible. If the document becomes
hidden before the answer, the attempt and correctness remain valid, `response_ms` is `NULL`, and
attempt metadata records `timingInterrupted: true`. Interrupted attempts do not contribute to
average latency, slow-item evidence, or weak/slow selection priority. Other activities do not gain
automaticity meaning merely because they happen to record elapsed UI time.

When an upgraded browser knows a legacy session's completed count but lacks its earlier per-answer
cache, the local summary preserves the total and marks the available distribution as partial.
Canonical synchronization replaces that projection with the complete attempt-derived summary.

## History and Progress

Session History answers “what did I practice, with which settings, and how did that set go?” Long-term
Progress remains the canonical accumulated learner-state projection from `getProgressSnapshot()`.
History is bounded and session-shaped; Progress is longitudinal and projection-shaped. Future
Notion/MCP projections continue to use Progress rather than transient UI or cached result state.

## Practice semantics repair

The default pronunciation mix contains `hanzi_to_pinyin`, `pinyin_to_hanzi`, the two audio
activities, and `tone_identification`. `tone_pair_identification` remains focused practice and
asks for two bounded Tone 1–5 choices in sequence; its persisted answer remains the canonical pair
such as `3-3`, not a 25-button matrix. `pronunciation_production` remains focused practice with a
Hanzi prompt, speak-compare reveal, and exact-reading audio when available. New production attempts
are ungraded; historical production self-ratings remain readable.

`hanzi_to_pinyin` records self-reported recall separately from objectively graded pronunciation
activities. Reading records staged completion without a comprehension rating. Grammar records the
objective choice result and feedback without a confidence question; the nullable grammar topic
confidence projection and old confidence evidence remain for historical compatibility. Current
Progress uses objective correctness plus practiced/introduced topic evidence; confidence-era
`learning`/`comfortable` state is not presented as current objective mastery. Retired subjective
ratings remain readable in history but do not create current trouble candidates. No mode creates a
synthetic cross-activity practice score.
