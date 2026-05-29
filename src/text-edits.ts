/**
 * Shared text-edit helpers — the same "apply a set of [start, end) → text
 * splices to a string" appeared in 6 places with subtle drift (`span.start +
 * span.length` vs `e.end`, missing tie-breaks, different quote-escape
 * branches). Consolidating here keeps the splice semantics in one place;
 * future fixes (zero-length-span handling, overlap detection) land once.
 */
import type {ts} from './ts-loader.js';

export interface TextEdit {
    start: number;
    end: number;
    text: string;
}

/**
 * Apply a set of `[start, end) → text` edits to `original`. Edits may be in
 * any order; we sort right-to-left so applied splices don't shift positions
 * downstream of the cursor.
 *
 * Tie-break: when two edits share `start`, the one with the LARGER `end`
 * applies first. That keeps a delete-then-insert pair (start=A end=B, then
 * start=A end=A) deterministic — without a tie-break TS LS occasionally
 * emits both and the insert order is unstable, silently losing one.
 *
 * Overlap (different starts but ranges intersect) is detected and throws —
 * applying overlapping edits is always a bug at the call site.
 */
export function applyEdits(original: string, edits: readonly TextEdit[]): string {
    if (edits.length === 0) return original;
    const sorted = [...edits].sort((a, b) => {
        if (a.start !== b.start) return b.start - a.start;
        return b.end - a.end;
    });
    // Overlap check — only meaningful for distinct starts (sibling deletes at
    // the same position are fine and handled by the tie-break).
    for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const next = sorted[i + 1];
        if (cur.start !== next.start && next.end > cur.start) {
            throw new Error(
                `applyEdits: overlapping edits [${next.start},${next.end}) and [${cur.start},${cur.end})`,
            );
        }
    }
    let out = original;
    for (const e of sorted) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
}

/**
 * Apply TypeScript LS `TextChange[]` (which uses `{span: {start, length}, newText}`)
 * via the unified `applyEdits` path. Translates the shape once at the
 * boundary instead of every callsite re-deriving `span.start + span.length`.
 */
export function applyTsTextChanges(original: string, changes: readonly ts.TextChange[]): string {
    const edits: TextEdit[] = changes.map((c) => ({
        start: c.span.start,
        end: c.span.start + c.span.length,
        text: c.newText,
    }));
    return applyEdits(original, edits);
}

/**
 * Preserve the original quote style at `literalStart` when emitting a
 * replacement string literal. Reads the actual quote char (single, double,
 * or backtick) and escapes accordingly. Falls back to `JSON.stringify` for
 * the rare case the position doesn't sit on a known quote (defensive).
 *
 * Three places had hand-rolled copies of this — `imports.ts:70` (inline
 * ternary), `extract.ts:692` (`quote`), `extract-postprocess.ts:302`
 * (`emitSameQuoteStyle`). One escape-edge-case fix now applies everywhere.
 */
export function emitQuoted(source: string, literalStart: number, text: string): string {
    const q = source[literalStart];
    if (q === "'") return "'" + text.replace(/'/g, "\\'") + "'";
    if (q === '`') return '`' + text.replace(/`/g, '\\`') + '`';
    if (q === '"') return '"' + text.replace(/"/g, '\\"') + '"';
    return JSON.stringify(text);
}
