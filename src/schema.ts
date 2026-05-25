/**
 * Public op schema. Three forms:
 *
 *   SHORT tuple:    ["src/components/SalesPage", "src/components/SalesView"]
 *
 *   FULL move:      {
 *     "from": "src/components/SalesPage",
 *     "to":   "src/components/SalesView",
 *     "renameSymbols": [{"old": "SalesPage", "new": "SalesView"}]
 *   }
 *
 *   EXTRACT:        {
 *     "extract": "Header",
 *     "from":    "src/Sales/Sales.tsx",
 *     "to":      "src/Sales/Header/Header.tsx",
 *     "css":     "none"
 *   }
 *
 * Paths are relative to the project root. Folder vs file is inferred from
 * the extension (no extension = folder).
 *
 * `renameSymbols` is an OPTIONAL list of identifier renames to apply when
 * this op runs. If omitted (short form, or full form without the field), the
 * tool auto-detects ONE symbol rename from basename changes:
 *   - folder op, basename(from) ≠ basename(to), and `<from>/<basename(from)>.tsx` exists
 *     → auto-add `{old: basename(from), new: basename(to)}`
 *   - file op, basename(from, ext) ≠ basename(to, ext)
 *     → auto-add `{old: basename(from), new: basename(to)}`
 * Pass an empty array `renameSymbols: []` to suppress auto-detection.
 *
 * `extract` uses the TypeScript language service "Move to a new file" refactor
 * to lift a top-level declaration out of `from` into a new file at `to`. The
 * `css` field controls sibling stylesheet handling:
 *   - "none" (default) — styles are NOT touched; the extracted file keeps a
 *     relative import to the original `.module.scss`.
 *   - "copy-safe", "empty-stub" — coming in 2.1.
 */
export type RefactorOpInput = RefactorOpShort | RefactorOpFull | RefactorOpExtract;

export type RefactorOpShort = [from: string, to: string];

export interface RefactorOpFull {
    from: string;
    to: string;
    renameSymbols?: Array<{old: string; new: string}>;
}

export interface RefactorOpExtract {
    extract: string;
    from: string;
    to: string;
    css?: 'none' | 'copy-safe' | 'empty-stub';
}

export interface OpsInput {
    ops: RefactorOpInput[];
}

/** Discriminator on `kind`. */
export type RefactorOp = RefactorOpMoveNormalized | RefactorOpExtractNormalized;

export interface RefactorOpMoveNormalized {
    kind: 'move';
    from: string;
    to: string;
    renameSymbols: Array<{old: string; new: string}>;
}

export interface RefactorOpExtractNormalized {
    kind: 'extract';
    extract: string;
    from: string;
    to: string;
    css: 'none' | 'copy-safe' | 'empty-stub';
}

/** Augmented form after preflight. */
export type NormalizedOp = NormalizedMoveOp | NormalizedExtractOp;

interface NormalizedOpBase {
    /** Index in the original input array. */
    index: number;
    fromAbs: string;
    toAbs: string;
}

export interface NormalizedMoveOp extends NormalizedOpBase, RefactorOpMoveNormalized {
    isFolder: boolean;
    sameParent: boolean;
}

export interface NormalizedExtractOp extends NormalizedOpBase, RefactorOpExtractNormalized {
    /** Extract is always file-shape. */
    isFolder: false;
}

/** One level of the execution plan; ops within the same level are mutually independent. */
export interface PlanLevel {
    level: number;
    ops: NormalizedOp[];
}
