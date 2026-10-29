/**
 * Raw vendor data helpers.
 *
 * CapCut and OpenCut both carry fields we do not model. Those fields live in
 * each normalized node's `raw` bag so they survive a read → mutate → write
 * round-trip. This module is the only sanctioned place where an arbitrary
 * vendor object is widened into `RawBag`; everything else consumes the guards
 * so `unknown` stays `unknown`.
 */

/** A bag of unmodelled vendor fields, mutable by design. */
export type RawBag = Record<string, unknown>;

/** True when `value` is a plain object we can read keys off. */
export function isRecord(value: unknown): value is RawBag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Widen a known vendor object into a RawBag for storage.
 *
 * This is a widening, not a lie: the caller already knows the shape (a CapCut
 * `draft_content.json` root, an OpenCut project root), and we only need a
 * mutable view of it. Arrays are rejected because a bare array is never a
 * vendor root.
 */
export function toRawBag(value: unknown): RawBag {
  return isRecord(value) ? value : {};
}

/** Read a nested object bag, creating it when missing. */
export function ensureBag(parent: RawBag, key: string): RawBag {
  const existing = parent[key];
  if (isRecord(existing)) return existing;
  const created: RawBag = {};
  parent[key] = created;
  return created;
}

/** Read a string field, or `undefined` when absent/not a string. */
export function readString(bag: RawBag | undefined, key: string): string | undefined {
  if (!bag) return undefined;
  const value = bag[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a finite number field, or `undefined`. */
export function readNumber(bag: RawBag | undefined, key: string): number | undefined {
  if (!bag) return undefined;
  const value = bag[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean field, or `undefined`. */
export function readBoolean(bag: RawBag | undefined, key: string): boolean | undefined {
  if (!bag) return undefined;
  const value = bag[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read an array field, or an empty array when absent/not an array. */
export function readArray<T = unknown>(bag: RawBag | undefined, key: string): T[] {
  if (!bag) return [];
  const value = bag[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Shallow copy of a bag, so callers can spread without mutating the cache. */
export function copyBag(bag: RawBag | undefined): RawBag {
  return bag ? { ...bag } : {};
}

/** True when the value exposes a string property at `key`. */
export function hasString(value: unknown, key: string): boolean {
  return isRecord(value) && typeof value[key] === "string";
}
