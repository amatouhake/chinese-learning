---
name: Chinese Learning
description: A focused, offline-first Chinese practice instrument for a fast daily ritual.
colors:
  ink: "#0d1016"
  ink-raised: "#151a22"
  ink-raised-2: "#1c232d"
  ink-line: "#303946"
  ink-line-bright: "#4a5665"
  paper: "#f6f0e5"
  paper-soft: "#ece3d5"
  paper-muted: "#d9cdbc"
  paper-ink: "#1a2028"
  paper-muted-ink: "#656e78"
  vermilion: "#f06452"
  vermilion-deep: "#c7483b"
  vermilion-wash: "#ffe0d9"
  reading-cue: "#79cbd6"
  reading-cue-deep: "#1c6470"
  reading-cue-wash: "#d8f1f1"
  correct: "#78d7a8"
  correct-ink: "#123a2c"
  correct-wash: "#d8f3e5"
  muted: "#a7b0bb"
  muted-dim: "#76818f"
typography:
  display:
    fontFamily: "Hiragino Mincho ProN, Yu Mincho, Noto Serif CJK JP, Noto Serif SC, serif"
    fontSize: "clamp(4rem, 23vw, 7.5rem)"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "-0.08em"
  headline:
    fontFamily: "Hiragino Mincho ProN, Yu Mincho, Noto Serif CJK JP, Noto Serif SC, serif"
    fontSize: "clamp(1.6rem, 7.8vw, 2.8rem)"
    fontWeight: 760
    lineHeight: 1.2
    letterSpacing: "-0.045em"
  title:
    fontFamily: "Hiragino Sans GB, Yu Gothic, Noto Sans CJK JP, Noto Sans SC, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.08rem"
    fontWeight: 760
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Hiragino Sans GB, Yu Gothic, Noto Sans CJK JP, Noto Sans SC, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.84rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Hiragino Sans GB, Yu Gothic, Noto Sans CJK JP, Noto Sans SC, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.62rem"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  badge: "0.42rem"
  control: "0.65rem"
  action: "0.7rem"
  card: "1.15rem"
  circle: "50%"
spacing:
  hairline: "0.2rem"
  compact: "0.55rem"
  control: "0.8rem"
  section: "1rem"
  stage: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.vermilion-deep}"
    textColor: "#fff7ef"
    typography: "{typography.title}"
    rounded: "{rounded.action}"
    padding: "0 1rem"
    height: "3.6rem"
  button-secondary:
    backgroundColor: "{colors.paper-soft}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 0.85rem"
    height: "2.55rem"
  study-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.paper-ink}"
    rounded: "{rounded.card}"
    padding: "1rem"
  answer-choice:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.65rem"
    height: "4.25rem"
  audio-control:
    backgroundColor: "{colors.reading-cue-wash}"
    textColor: "{colors.reading-cue-deep}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 0.8rem"
    height: "2.8rem"
  surface-navigation:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.muted-dim}"
    typography: "{typography.label}"
    rounded: "0.55rem"
    padding: "0.35rem 0.55rem"
    height: "2.6rem"
---

# Design System: Chinese Learning

## Overview

**Creative North Star: "Night Proof Desk"**

Chinese Learning is a quiet instrument for repeated use: a dark ink workspace holds one
warm paper proof sheet at a time. The learner commits to one answer, sees the proof of
that answer immediately, and moves on. Vermilion marks the decisive action and the
mistake; a cool reading cue marks sound, pinyin, and the path back into the material.

The system is editorial rather than dashboard-like. It uses crisp rails, restrained
surface changes, and a small number of highly legible states to make the next decision
obvious on a phone. The replacement world intentionally leaves the incumbent beige/green
shell behind. It has no dependency on remote fonts, imagery, or network-only decoration.

**Key Characteristics:**

- Midnight ink shell with a single warm paper learning stage.
- Vermilion proof marks and cobalt/cyan reading cues used with purpose.
- Stable answer rails that paint in place for feedback.
- Japanese/Chinese serif display paired with a compact system UI sans; the interface is
  Japanese-first while the learning content stays faithful to its source language.
- Sound and exact-reading media are enhancements, never hidden correctness gates.

## Colors

The palette is an instrument panel: dark ink recedes, warm paper carries study content,
vermilion calls for a decision, and the cool reading cue opens the ear and the memory.

### Primary

- **Vermilion Proof Mark**: The decisive action, due state, and incorrect state.
- **Deep Vermilion**: The resting fill for reveal and primary actions; it is deliberately
  scarce so an actionable red remains unmistakable.

### Secondary

- **Reading Cue**: Sound controls, pinyin, and the quiet positive route through a card.
- **Deep Reading Cue**: Text and borders on pale paper where contrast matters.

### Tertiary

- **Correct Green**: Confirmation after an answer, always paired with an explicit label.

### Neutral

- **Ink**: The application shell and the space around active practice.
- **Raised Ink**: Start states, progress surfaces, and supporting dark containers.
- **Ink Line**: Structural rails in the shell.
- **Paper**: The primary study card and high-attention content.
- **Soft Paper**: Choice-key wells, examples, and secondary controls.
- **Paper Ink**: Main text on paper.
- **Paper Muted Ink**: Metadata and supporting copy on paper.
- **Muted / Dim Muted**: Supporting copy on the dark shell.

**The One Proof Mark Rule.** Vermilion is reserved for the decision, the mistake, or
the single most important call to action on a surface. Do not turn every label into an
accent.

## Typography

**Display Font:** Hiragino Mincho ProN / Yu Mincho / Noto Serif CJK JP / Noto Serif SC
(with a local system serif fallback)

**Body Font:** Hiragino Sans GB / Yu Gothic / Noto Sans CJK JP / Noto Sans SC (with a
local system sans fallback)

**Label/Mono Font:** The body stack with tabular numerals for progress and keyboard keys.

**Character:** The serif makes a single Hanzi feel intentional and studied; the sans
keeps navigation, timing, and metadata quick to scan. All families are local/system
stacks so the installed PWA remains typographically complete offline.

### Hierarchy

- **Display** (650, `clamp(4rem, 23vw, 7.5rem)`, 1): A single Hanzi prompt or answer.
- **Headline** (760, `clamp(1.6rem, 7.8vw, 2.8rem)`, 1.2): Meaning prompts and short
  completion headings.
- **Title** (760, `1.08rem`, 1.2): Surface names and compact section headings.
- **Body** (400, `0.84rem`, 1.4): Meanings, examples, and supporting instructions.
- **Label** (900, `0.62rem`, 1.2, `0.08em`, uppercase where used): Queue state, mode,
  keyboard hint, and status metadata.

**The Two-Register Rule.** Use serif for what the learner is trying to remember; use
sans for what the interface is asking the learner to do.

## Layout

The shell uses a sticky dark header and a centered learning rail. The full application
is capped at `78rem`; active learning surfaces are capped at `54rem` so a phone and a
desktop both keep a clear focal stage. Desktop navigation occupies one header row. At
phone widths it becomes a compact brand row with a designed five-mode menu (`単語`, `瞬発`,
`発音`, `読解`, `進捗`) and an icon-only sound control; the active surface header keeps only
useful progress or sync context.

Active Study and Reflex cards use a warm-paper stage with a stable internal rhythm:
metadata, prompt, answer rail, and progression. Phone choices are two columns with
comfortable targets; desktop expands them to four columns. The Study rating rail follows
the same 2-by-2 to 4-across rule. Active cards are sized against the viewport so the
prompt, feedback, and next action normally remain visible at 320px and 390px widths.
Long-form Progress and reference content may extend naturally.

The spacing rhythm is compact on the shell (`0.2rem` hairlines, `0.55rem` control gaps,
`1rem` sections) and generous inside a prompt (`1.5rem` stage padding). Every active
state reserves space for its feedback rail; answering should paint the existing geometry,
not create a new page.

## Elevation & Depth

Depth is a hybrid of tonal layering and one structural shadow. Ink surfaces are mostly
flat and differentiated by line color. The warm paper card carries a broad, low-contrast
shadow to separate the learning stage from the shell. Pale controls sit inside the card
by color and border rather than by floating elevation. Focus uses a cyan outline, never a
blurred glow.

### Shadow Vocabulary

- **Learning stage:** `0 1.2rem 3.4rem rgb(0 0 0 / 22%)`; the one broad shadow around a
  study card or status panel.
- **Audio focus:** `0 0.8rem 1.8rem rgb(16 75 82 / 20%)`; reserved for the circular
  pronunciation control.
- **No decorative lift:** Do not add shadows to every choice or nav item.

**The Flat-By-Default Rule.** Resting controls are defined by paper, ink, border, and
state color. Motion and depth appear only when they clarify focus, response, or the
learning stage.

## Shapes

The form language is a crisp editorial rectangle softened just enough for touch. Cards
use a generous `1.15rem` radius; controls use a repeatable `0.65rem` radius; queue badges
and keyboard wells use smaller radii. The audio control is the one circle because it is
an unmistakable playback action. Borders are one-pixel structural rails, not ornamental
frames. Avoid pills except for compact queue/status badges.

## Components

### Buttons

- **Shape:** Soft editorial corners (`0.65rem` for controls, `0.7rem` for primary actions).
- **Primary:** Deep vermilion fill, warm white text, full-width `3.6rem` action height,
  and a keyboard hint when the action has a shortcut.
- **Hover / Focus:** Hover moves from deep to bright vermilion. Every interactive element
  receives a visible `3px` cyan focus outline with `3px` offset.
- **Secondary:** Soft paper fill with paper ink and a thin muted-paper border; use for
  Continue, Check again, and non-destructive next actions.

### Chips

- **Style:** Queue and mode badges are compact rectangular marks, not decorative pills.
  Cyan marks new material; vermilion marks due material; muted paper marks reference
  context.
- **State:** The badge explains the queue or mode; it never replaces the main heading.

### Cards / Containers

- **Corner Style:** Warm paper cards use `1.15rem`; dark support surfaces use the same
  silhouette with a quieter border.
- **Background:** One paper learning stage against the ink shell. Do not stack multiple
  competing white cards during a drill.
- **Shadow Strategy:** Follow the single learning-stage shadow in Elevation & Depth.
- **Border:** One-pixel ink or muted-paper rail, with vermilion/correct state rails only
  when they carry feedback.
- **Internal Padding:** `1rem` by default, `1.2rem` on wider screens, `0.8rem` at 320px.

### Navigation

- **Style:** A compact dark rail with inline SVG line icons on desktop. Narrow phones use
  a custom touch-sized five-mode menu whose current label remains visible and whose selected
  item is marked in the Night Proof Desk ink-raised surface; the active mode is never hidden
  behind an unlabeled icon.
- **Behavior:** Navigation is available between sessions and remains quiet during a card.
  The surface header does not repeat the selected mode on a phone when the global selector
  already identifies it. Sound preference lives in the same header as a persistent toggle:
  its mobile treatment is icon-only visually but retains its accessible name, title, and
  pressed state.

### Proof Feedback Rail

The four answer targets are the feedback surface. In Reflex, the correct choice paints
green, the selected wrong choice paints vermilion, the remaining disabled choices recede,
and the feedback row names the answer and exposes Continue. This preserves spatial memory
and makes correctness legible through text, color, and restrained sound together.

### Exact-Reading Audio

Listen controls appear beside an ordinary Study or Reflex prompt only when a reliable
exact-reading media mapping exists. Playback is optional and controlled by the persistent
Sound toggle. Missing, ambiguous, uncached, or unplayable media produces a quiet status
message or disappears from the ordinary card; it never borrows another reading.

## Do's and Don'ts

### Do:

- **Do** make one prompt, one decision, and one next action dominant in every active drill.
- **Do** keep answer and feedback geometry stable across prompt and result states.
- **Do** pair correctness words with state color; never rely on green or red alone.
- **Do** use local/system font stacks and inline SVG icons so the PWA is complete offline.
- **Do** keep touch targets comfortable and keyboard shortcuts discoverable on desktop.
- **Do** treat exact-reading media as verified only when the canonical mapping is unique.

### Don't:

- **Don't** return to a generic dashboard composition during a high-frequency drill.
- **Don't** add gradients, glass effects, remote fonts, or decorative imagery to the active
  learning surface.
- **Don't** let answer text, examples, or error copy push the next action below the phone
  viewport when a compact alternative is available.
- **Don't** use sound as the only correctness signal or block progress on audio playback.
- **Don't** borrow pronunciation from a different Hanzi-reading identity.
- **Don't** make Japanese learners parse English interface copy during a rapid drill.
- **Don't** fill every surface with vermilion, rounded pills, or implementation-oriented
  explanatory copy.
