// Local audit ring buffer (G6). Metadata only — no prompt/response text is ever
// stored here (matches DNey's metadata-only logging posture).
import type { AuditEvent } from "./types";

export class AuditLog {
  private buf: AuditEvent[] = [];
  constructor(private max: number) {}

  add(event: AuditEvent): void {
    this.buf.push(event);
    while (this.buf.length > this.max) this.buf.shift();
  }

  /** Most-recent-first, up to `n`. */
  recent(n = 20): AuditEvent[] {
    return this.buf.slice(-n).reverse();
  }

  exportJSON(): string {
    return JSON.stringify(this.buf, null, 2);
  }

  get size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
  }
}
