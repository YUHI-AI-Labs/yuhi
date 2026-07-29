# Security

The Yuhi VS Code extension follows the security policy of the Yuhi project.

- **Policy and reporting:** see the root
  [`SECURITY.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/.github/SECURITY.md).
- **Threat model:** see
  [`THREAT_MODEL.md`](https://github.com/YUHI-AI-Labs/yuhi/blob/main/docs/THREAT_MODEL.md).

## Important: not a sandbox

Yuhi prepares — locally — the context an AI agent would start from. It is
**defense-in-depth, not a sandbox**. Any agent you launch afterwards still has full
network and OS access. Preparation and review in this extension run entirely on your
machine and forward nothing externally.

Please report vulnerabilities privately per the root policy above — do not open a public
issue for security reports.
