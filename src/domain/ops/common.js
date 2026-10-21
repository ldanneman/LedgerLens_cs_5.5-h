/**
 * Shared plumbing for every mutation ("op").
 *
 * Contract: an op is a pure function `(data, input, ctx?) => Result` where
 *   Result = { ok:true, data, warnings:string[], ...extra } | { ok:false, errors:[{message, field?}] }
 * Ops never modify their input. They build the next dataset with Immer, then run the
 * structural validator on the RESULT; if it contains any blocking finding the whole
 * operation is rejected and the caller keeps the previous dataset. That makes every
 * mutation atomic (all-or-nothing) and keeps invalid data from ever being "saved".
 */
import { produce } from 'immer';
import { validateStructure } from '../validate.js';

/** Thrown inside a recipe to abort with user-facing messages. */
export class OpError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list[0].message);
    this.errors = list;
  }
}

/** Build an error entry. */
export const err = (message, field) => ({ message, field });

/** Abort the current recipe with one or more errors. */
export function abort(...errors) {
  throw new OpError(errors.flat().map((x) => (typeof x === 'string' ? err(x) : x)));
}

/** Failure result helper. */
export const fail = (...errors) => ({ ok: false, errors: errors.flat().map((x) => (typeof x === 'string' ? err(x) : x)) });

/**
 * Run `recipe(draft)` against a draft of `data`; validate and return a Result.
 * The recipe may return `{ warnings: [...], ...extra }`.
 */
export function mutate(data, recipe) {
  let out = {};
  let next;
  try {
    next = produce(data, (draft) => {
      out = recipe(draft) || {};
    });
  } catch (e) {
    if (e instanceof OpError) return { ok: false, errors: e.errors };
    throw e;
  }
  const blocking = validateStructure(next).filter((f) => f.blocking);
  if (blocking.length) {
    return {
      ok: false,
      errors: blocking.slice(0, 6).map((f) => ({ message: f.message, code: f.code })),
      blockingCount: blocking.length,
    };
  }
  const { warnings = [], ...extra } = out;
  return { ok: true, data: next, warnings, ...extra };
}

/** Trim helper that tolerates non-strings. */
export const clean = (v) => (typeof v === 'string' ? v.trim() : v);

/** Normalise a tag list: trim, drop empties, dedupe case-insensitively, keep order. */
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim().replace(/\s+/g, ' ');
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}
