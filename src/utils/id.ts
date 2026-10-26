/**
 * Minimal id + time helpers shared across tools.
 */

import { nanoid } from "nanoid";

/** Generate a short unique id (used for new clips, materials, etc.). */
export function uid(prefix = ""): string {
  return `${prefix}${nanoid(12)}`;
}

/** Microseconds to seconds. */
export function usToS(us: number): number {
  return us / 1_000_000;
}

/** Seconds to microseconds. */
export function sToUs(s: number): number {
  return Math.round(s * 1_000_000);
}

/** Format microseconds as HH:MM:SS.mmm for human-readable summaries. */
export function formatUs(us: number): string {
  const totalMs = Math.floor(us / 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** ISO timestamp now. */
export function nowIso(): string {
  return new Date().toISOString();
}
