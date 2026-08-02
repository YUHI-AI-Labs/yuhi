/**
 * v0.3.5 persistent cancellation for background preparation.
 *
 * A cancel must not merely rewrite an item's status — the worker that is (or will
 * be) processing the run has to SEE the request and stop, even when it runs in a
 * different process or starts later. So a cancel is recorded durably here, in the
 * PRIVATE background dir (outside any agent-visible root), and the worker re-reads
 * this file while it runs. A provider result that arrives after a cancel is
 * discarded and never published.
 *
 * The file is tiny and re-read on demand (no in-memory caching across a check) so a
 * cross-process cancel is honored promptly.
 */
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

interface CancelFile {
  /** Whole-run cancel: every item in the run is aborted. */
  run?: boolean;
  /** Individually cancelled item ids. */
  items?: string[];
}

export class CancelStore {
  private readonly file: string;

  constructor(privateDir: string) {
    this.file = path.join(privateDir, "cancellations.json");
  }

  private read(): CancelFile {
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as CancelFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private async write(next: CancelFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next), "utf8");
    await fs.rename(tmp, this.file);
  }

  /** Persist a whole-run cancel. */
  async requestRun(): Promise<void> {
    const current = this.read();
    await this.write({ ...current, run: true });
  }

  /** Persist a single-item cancel. */
  async requestItem(itemId: string): Promise<void> {
    const current = this.read();
    const items = new Set(current.items ?? []);
    items.add(itemId);
    await this.write({ ...current, items: [...items] });
  }

  /**
   * True when this item (or the whole run) has been cancelled. Reads from disk on
   * every call so a cancel written by another process is seen immediately.
   */
  isCancelled(itemId: string): boolean {
    const current = this.read();
    if (current.run) return true;
    return (current.items ?? []).includes(itemId);
  }

  /** True when the whole run has been cancelled. */
  isRunCancelled(): boolean {
    return this.read().run === true;
  }
}
