/**
 * Tiny FS helpers shared across modules. Anything that's "node:fs but with
 * try/catch" lands here so we don't redefine `safeStat` in every consumer.
 */
import * as fs from 'node:fs';

/**
 * `fs.statSync` that never throws — returns null when the entry doesn't exist
 * or is inaccessible. Used to probe disk presence without an `existsSync` +
 * `statSync` race (single syscall instead of two).
 */
export function safeStat(p: string): fs.Stats | null {
    try {
        return fs.statSync(p);
    } catch {
        return null;
    }
}
