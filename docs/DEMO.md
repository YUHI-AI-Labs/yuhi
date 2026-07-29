# Making the demo GIF

The README's 30-second GIF shows the whole story: `yuhi status` (the AI context is
98% smaller) → `yuhi preview` (exactly what Claude sees) → `yuhi run` (launch on the
clean context). Two ways to produce it.

## Prerequisites

```bash
pnpm install && pnpm build      # the demo drives the built CLI
```

## Option A — VHS (recommended, fully reproducible)

[VHS](https://github.com/charmbracelet/vhs) turns a script into a GIF, so the demo is
regenerated identically on every change.

```bash
brew install vhs                # or see the VHS repo for Linux/Windows
vhs docs/demo.tape              # writes docs/demo.gif
```

Then reference it in the README:

```markdown
![Yuhi demo](docs/demo.gif)
```

## Option B — asciinema + agg (terminal recording)

```bash
brew install asciinema agg
asciinema rec demo.cast -c "bash scripts/demo.sh"
agg demo.cast docs/demo.gif
```

`scripts/demo.sh` runs the same `status → preview → run dummy` sequence against
`examples/demo`. Set `PAUSE=1.5` to slow it down, `PAUSE=0` for a fast dry run.

## A static screenshot instead

For a single hero image, screenshot the visual "AI Context" view (the same numbers,
rendered): it leads with **98% smaller** and the before → after. See the project's
published artifact, or open the CLI `yuhi status` output.

## Notes

- The demo isolates its runtime data under a temporary `YUHI_HOME`, so it never
  touches your real `~/.yuhi`.
- `yuhi run dummy` uses the bundled offline agent, so the GIF records with no network
  and no real API key. Swap `dummy` → `claude` for a real run.
