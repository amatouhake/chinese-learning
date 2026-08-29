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

The v1 project references `audio-cmn` (CC-BY-SA). No audio files or derived audio assets are present
in this repository. Any later media import must preserve its attribution/share-alike obligations and
remain separate from the application code license.
