/**
 * Agent-specific instruction file generation (Yuhi v0.3.4).
 *
 * Each allowlisted agent reads a conventional instruction file from the repo root:
 *   - Claude Code → `CLAUDE.md`
 *   - Codex       → `AGENTS.md`
 *
 * When Yuhi hands a Prepared Workspace to an agent it writes a clearly-marked
 * "Yuhi section" into that file so the agent knows it is operating on a reduced,
 * sanitized copy. The write is ADDITIVE and MERGE-SAFE: existing user content is
 * never clobbered — the Yuhi section is delimited by stable markers so a re-run
 * updates only the region between them.
 *
 * All contents are PUBLIC-SAFE: they carry the (already public-safe) Context ID
 * and aggregate framing only — never absolute paths, secrets, or identities.
 */

/** The conventional root instruction filename for each known agent id. */
const INSTRUCTION_FILE_BY_ID: Record<string, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
};

/**
 * The conventional root instruction filename for an agent id, or null for a
 * vendor-neutral agent that has no convention (the foundation adapter ships none).
 */
export function instructionFileNameFor(agentId: string): string | null {
  return INSTRUCTION_FILE_BY_ID[agentId] ?? null;
}

export const YUHI_SECTION_BEGIN = "<!-- BEGIN YUHI CONTEXT -->";
export const YUHI_SECTION_END = "<!-- END YUHI CONTEXT -->";

export interface YuhiInstructionInput {
  agentDisplayName: string;
  /** The deterministic, agent-independent Context ID (`sha256:<hex>`). */
  contextId: string;
}

/**
 * Build the delimited Yuhi section (including its BEGIN/END markers). This is the
 * only region Yuhi owns inside a merged instruction file.
 */
export function buildYuhiInstructionSection(input: YuhiInstructionInput): string {
  const lines = [
    YUHI_SECTION_BEGIN,
    "## Yuhi Prepared Workspace",
    "",
    `This repository is a **Yuhi Prepared Workspace** — a local, reduced, and`,
    "sanitized copy of a source project, prepared for you by Yuhi (an AI Context",
    "Runtime). High-risk files were excluded and sensitive values were redacted by",
    "recommendation before you were given access.",
    "",
    `- Context ID: \`${input.contextId}\``,
    `- Agent: ${input.agentDisplayName}`,
    "",
    "Work only within this directory. Treat any remaining redaction placeholders",
    "(for example `${VAR}` in an `.env`) as intentional — do not attempt to recover",
    "original secrets or reach outside this prepared copy.",
    YUHI_SECTION_END,
  ];
  return lines.join("\n");
}

/**
 * Merge the Yuhi section into an existing instruction file's contents without
 * clobbering user content.
 *
 *   - no existing file / empty → the Yuhi section becomes the file
 *   - existing file WITH markers → the region between markers is replaced in place
 *   - existing file WITHOUT markers → the Yuhi section is appended, clearly marked
 */
export function mergeInstructionFile(existing: string | null, yuhiSection: string): string {
  const section = yuhiSection.trimEnd();
  if (existing === null || existing.trim() === "") {
    return `${section}\n`;
  }
  const begin = existing.indexOf(YUHI_SECTION_BEGIN);
  const end = existing.indexOf(YUHI_SECTION_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + YUHI_SECTION_END.length);
    return `${before}${section}${after}`;
  }
  return `${existing.trimEnd()}\n\n${section}\n`;
}
