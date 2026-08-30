# Third-party content notices

Application code in this repository is covered by the root `LICENSE`. Content imported with the v1
importer retains its source provenance and license. Audio is intentionally not committed.

## complete-hsk-vocabulary

- Source: <https://github.com/drkameleon/complete-hsk-vocabulary>
- Role: HSK 2.0 vocabulary, forms/readings, pinyin, meanings, POS, and frequency metadata
- License: MIT
- Fixture/source revision inspected for this foundation:
  `7ac65bf1a6387d35f1ade478906172a19311c7f9`
- Copyright (c) 2026 Yanis Zafirópulos

The small test fixture under `tests/fixtures/v1-reference/wordlists/` is adapted from this source.

## why-learn-languages-when-we-have-llms-lol

- Source: <https://github.com/amatouhake/why-learn-languages-when-we-have-llms-lol>
- Role: v1 Japanese meanings and LLM-generated example-sentence enrichment; provenance/reference
  behavior only, never FSRS history
- License: MIT
- Fixture/source revision inspected for this foundation:
  `6bd4b8dfc45a97fdeca20efeeab0d6d81d236847`
- Copyright (c) 2025 amatouhake

The importer labels generated sentence metadata as LLM-generated and unreviewed. Old reflex response
history is not read or converted into FSRS reviews.

## MIT license text for the sources above

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Audio sources

### audio-cmn

- Source: <https://github.com/hugolpz/audio-cmn>
- Role: Mandarin word recordings used for the pronunciation listening and compare steps
- Source revision: `ff9ed3d0c631195bd2c06f39450f3264c7124040`
- Imported path: `64k/hsk/cmn-{Hanzi}.mp3`
- License: Creative Commons Attribution-ShareAlike (CC BY-SA), as declared by the source
- Attribution in the source: Yue Tan; collected for the Spoken Wikipedia Corpora (SWAC)

The corpus is not committed here. The pronunciation importer reads a separately pinned checkout,
verifies each contributing worktree file against the Git blob at the revision above, and copies only
reliably mapped recordings to ignored `.generated/public/media/` for local delivery. The generated
report retains the source commits and explicit ambiguous/missing issue lists. Each D1 media record
retains the source name, license, attribution, source path, commit, byte length, digest, and stable
content identity. Those staged audio files retain CC BY-SA and are not relicensed by the
application's MIT license.

Because these word files are named by Hanzi rather than a reading identifier, the importer refuses
to attach a file to a lexeme with multiple active readings. This avoids making a false provenance
claim about the recording's pronunciation.
