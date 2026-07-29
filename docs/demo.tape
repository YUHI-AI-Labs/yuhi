# Yuhi — 30-second demo. Generates docs/demo.gif for the README.
#
#   1. Build the CLI:   pnpm install && pnpm build
#   2. Install VHS:     https://github.com/charmbracelet/vhs  (brew install vhs)
#   3. Record:          vhs docs/demo.tape   # writes docs/demo.gif
#
# Run from the repo root.

Output docs/demo.gif
Require node

Set Shell "bash"
Set FontSize 18
Set Width 1240
Set Height 820
Set Padding 26
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# --- setup (hidden): isolate runtime data + a local `yuhi` for the demo ---
Hide
Type "export YUHI_HOME=$(mktemp -d)/yuhi-demo" Enter
Type "cd examples/demo" Enter
Type 'yuhi() { node ../../apps/cli/dist/index.js "$@"; }' Enter
Type "clear" Enter
Show

# --- 1. What does my AI actually know? (the 98% story) ---
Type "yuhi status" Sleep 400ms Enter
Sleep 4s

# --- 2. Exactly which files Claude will and will not see ---
Type "yuhi preview" Sleep 400ms Enter
Sleep 4500ms

# --- 3. Launch the agent inside the clean, generated context ---
Type "yuhi run dummy" Sleep 400ms Enter
Sleep 4s
