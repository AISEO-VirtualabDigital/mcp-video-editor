/**
 * Notification bus — emits MCP server-sent notifications when projects change
 * or renders progress. The MCP server subscribes these to the SDK's
 * `ServerNotification` stream.
 *
 * Three notification kinds:
 *   - "notifications/projectChanged"  — every draft write, open, close, save, external
 *   - "notifications/renderProgress"  — queued / rendering / complete / error
 *   - "notifications/message"         — fallback progress logging
 *
 * The bus is a simple typed emitter. The MCP server owns the actual send
 * call (so it can frame messages correctly for whichever client is connected).
 */

import type { RenderProgressEvent, ProjectChangedEvent } from "../adapters/types.js";
import { nowIso } from "../utils/id.js";

type Listener<T> = (event: T) => void;

export class NotificationBus {
  private projectListeners = new Set<Listener<ProjectChangedEvent>>();
  private renderListeners = new Set<Listener<RenderProgressEvent>>();
  private logListeners = new Set<Listener<{ level: "info" | "warning" | "error"; message: string; at: string }>>();

  onProjectChanged(fn: Listener<ProjectChangedEvent>): () => void {
    this.projectListeners.add(fn);
    return () => this.projectListeners.delete(fn);
  }

  onRenderProgress(fn: Listener<RenderProgressEvent>): () => void {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  }

  onLog(fn: Listener<{ level: "info" | "warning" | "error"; message: string; at: string }>): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  emitProjectChanged(e: Omit<ProjectChangedEvent, "at">): void {
    const full: ProjectChangedEvent = { ...e, at: nowIso() };
    for (const fn of this.projectListeners) {
      try {
        fn(full);
      } catch {
        // listener should never break the bus
      }
    }
  }

  emitRenderProgress(e: Omit<RenderProgressEvent, "at">): void {
    const full: RenderProgressEvent = { ...e, at: nowIso() };
    for (const fn of this.renderListeners) {
      try {
        fn(full);
      } catch {
        // ignore
      }
    }
  }

  log(level: "info" | "warning" | "error", message: string): void {
    const payload = { level, message, at: nowIso() };
    for (const fn of this.logListeners) {
      try {
        fn(payload);
      } catch {
        // ignore
      }
    }
  }
}

/** Singleton bus — tools and adapters import this. */
export const bus = new NotificationBus();
