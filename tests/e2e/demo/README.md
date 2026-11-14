# README demo recorder

Re-records `docs/demo.mp4` and `docs/demo.gif` (the clip at the top of the project README) from
the real app:

```sh
cargo build && node tests/e2e/demo/record.mjs --out docs
```

It needs `tests/e2e/node_modules` (`cd tests/e2e && npm ci && npx playwright install chromium`)
and `ffmpeg` (Homebrew's `/opt/homebrew/bin/ffmpeg`, or one on PATH). A take runs for about
1.5 minutes, of which about 35s ends up in the clip.

The story follows the README caption: **Company profile** (a line typed into the ticked
profile, which saves) → **Agent** (a request, then a run that sources, enriches and drafts while
it streams, ending in "Worked · N steps" and a summary) → **Pipeline** (the new companies, one
company's drawer) → **Drafts** (the personalized intro for that company) → **Home** (the
numbers).

## Files

- `record.mjs`: starts `target/debug/coldtrail serve` against a throwaway workspace, drives
  Chromium at 1280x800 in the light theme with a visible cursor, and encodes the result.
  Options: `--out <dir>` (required), `--bin <path>`, `--gif-fps <n>` (15), `--gif-width <px>`
  (1280), `--frames <n>` (also write n evenly spaced review stills, `frame-XX.png`),
  `--headed`, `--keep` (keep the frames and the workspace, and print their paths).
- `seed.mjs`: the demo workspace. Ledgerlane, an invented reconciliation product, with about 40
  companies across every stage, drafts, replies, two schedules and some runs. It also writes
  the three batches the scripted run applies (24 new companies, the founders found for them,
  15 drafts), so the counts, Pipeline and Drafts really change during the take.
- `bin/opencode`: the scripted agent. It prints the `opencode run --format json` events that
  `src/provider/cli.rs` parses: `models` lists the demo model ids, the provider probe answers
  `ok`, and any other message plays one run of about 8s. `DEMO_OPENCODE_PACE` scales its pauses
  (0 makes it instant).

## Safety

The server gets the e2e harness's isolation (`serverEnv` from `../harness/server.mjs`):
`COLDTRAIL_HOME`, its secrets dir and `HOME` are fresh temp dirs (`coldtrail-demo-*`), and
`COLDTRAIL_NO_SEND`, `COLDTRAIL_NO_TIMERS` and `COLDTRAIL_NO_UPDATE` are set. Inherited
credential variables are dropped. `bin/` is first on PATH, followed by the harness's
`fake-bin` (whose `claude` and `codex` refuse). Canonical shows as connected through a fake
token whose endpoint is `.invalid`, and nothing sources for real. Gmail and LinkedIn are not
connected. Nothing touches `~/.coldtrail`, a real model, Gmail, Canonical or LinkedIn. The
script kills the server's process group and deletes its temp dirs when it finishes, or when it
is interrupted.

Every company, person and domain is fictional, and every domain is on the reserved `.example`
TLD. Keep it that way when you edit `seed.mjs`.

## Why screencast frames rather than `recordVideo`

Playwright's `recordVideo` encodes VP8 at a fixed 1 Mbit/s, which blurs small UI text. The
recorder takes Playwright's screencast frames (JPEG, quality 95) with their timestamps instead,
and encodes both outputs from those:

- the MP4 as H.264, yuv420p, CRF 23, 30 fps, faststart;
- the GIF with a two-pass palettegen/paletteuse at 15 fps (about 4 MB).

The clip starts once the first screen has loaded and ends after Home, so it has no dead frames
at either end.
