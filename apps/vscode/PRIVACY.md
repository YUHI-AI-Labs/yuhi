# Privacy

Yuhi is **local-first** by design.

## What happens on your machine

- **Preparation** runs a model **locally** through [Ollama](https://ollama.com) on your
  own computer. Your files' contents are read locally, summarized/reduced locally, and
  written locally to `.yuhi/prepared/<runId>/`. Your original files are never modified.
- **Review** renders entirely inside VS Code from that local output.

## What Yuhi does *not* do

- **No telemetry.** The extension collects no usage data, analytics, or crash reports.
- **No external network calls during preparation or review.** The only network traffic is
  to your local Ollama endpoint (default `http://127.0.0.1:11434`).
- **No automatic downloads.** A model is only ever downloaded when you explicitly confirm
  it in **Setup Local AI**, which then runs `ollama pull`. That download fetches model
  weights from Ollama's servers; it never includes anything about your code.
- **No forwarding to Claude.** This beta stops at the local review step. It does not send
  your prepared context anywhere.

## Third parties

- **Ollama** is a separate tool you install and run yourself; its downloads and network
  behavior are governed by Ollama, not Yuhi.

## Contact

Questions or concerns: open an issue at
<https://github.com/YUHI-AI-Labs/yuhi/issues>.
