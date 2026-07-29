# Yuhi Discussions

[GitHub Discussions](https://github.com/YUHI-AI-Labs/yuhi/discussions) is the place
for conversation that isn't a specific, actionable bug or feature request. Please
prefer Discussions over issues for anything open-ended.

## Suggested category structure

Enable these categories under **repo → Discussions → categories** (maintainer setup):

| Category | Format | Purpose |
|---|---|---|
| **📣 Announcements** | Announcement (maintainers post) | Releases, roadmap updates, calls for contributors. |
| **🙏 Q&A** | Question / Answer | Usage help, `yuhi.yaml` configuration, behavior questions. |
| **💡 Ideas** | Open | Float and refine feature ideas before they become issues. |
| **🎨 Show and tell** | Open | Share policies, detectors, workflows, and projects built with Yuhi. |
| **🔬 Research** | Open (uses the Research template) | Context-preparation research, ContextBench, collaboration. See [`RESEARCH.md`](../docs/RESEARCH.md). |
| **🗳️ Polls** | Poll | Gather quick community signal on direction. |

The **Research** category pairs with `.github/DISCUSSION_TEMPLATE/research.yml`
(GitHub applies the template when the category slug is `research`).

For concrete, trackable research proposals prefer the **Benchmark proposal** and
**Processor proposal** issue forms rather than a discussion.

## Please keep in mind

- **Security issues do not go here.** Never post vulnerabilities or exploit
  details publicly. Follow [SECURITY.md](./SECURITY.md) and report privately via
  the repository's **Security → Report a vulnerability**.
- **No real secrets.** When sharing config or output, use obviously fake values.
- **Be honest about scope.** Yuhi is defense-in-depth, not a sandbox or a
  security guarantee. Discussions should reflect that.
- Be kind and follow the [Code of Conduct](../docs/CODE_OF_CONDUCT.md).

## Where things go

| I want to...                                  | Use                     |
| --------------------------------------------- | ----------------------- |
| Report a reproducible bug                     | Issues → Bug report     |
| Request a specific, scoped feature            | Issues → Feature request|
| Ask a question / get help                     | Discussions → Q&A       |
| Float an early idea for feedback              | Discussions → Ideas     |
| Show off a project or workflow                | Discussions → Show and tell |
| Report a security vulnerability (privately)   | Security → Report a vulnerability |
