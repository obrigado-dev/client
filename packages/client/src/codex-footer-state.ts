/**
 * Reading Codex's snapshot without trusting it.
 *
 * The snapshot is JSON from another program, of a version that may not be the one this was
 * written against (`StatuslineState` in upstream's `statusline.d.ts`, Codex 0.171.0). Every read
 * goes through these, which answer null or undefined for a field that is missing or of the wrong
 * type and never throw, so a surprise costs the items that needed the field and nothing else.
 */
import type { FooterMachine, Repository } from "./codex-footer-local.ts";
import { findRepository } from "./codex-footer-local.ts";

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value at a path of keys, or undefined as soon as a step is not an object. */
export function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A whole number as Codex's `i64` fields arrive, or null. */
export function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** What one footer is drawn from. The repository is looked up once for both items that need it. */
export interface View {
  readonly state: unknown;
  readonly machine: FooterMachine;
  repository?: Repository | null;
}

/** The thread's working directory, `thread.workspace.cwd`. */
export function workingDirectory(view: View): string | null {
  return text(at(view.state, "thread", "workspace", "cwd"));
}

/** The repository the working directory is in, or null outside one. */
export function repository(view: View): Repository | null {
  if (view.repository === undefined) {
    const cwd = workingDirectory(view);
    view.repository = cwd === null ? null : findRepository(cwd, view.machine);
  }
  return view.repository;
}
