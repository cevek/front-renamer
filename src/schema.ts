/**
 * Public op schema — two equivalent forms:
 *
 *   SHORT (tuple):   ["src/components/SalesPage", "src/components/SalesView"]
 *
 *   FULL (object):   {
 *     "from": "src/components/SalesPage",
 *     "to": "src/components/SalesView",
 *     "renameSymbols": [{"old": "SalesPage", "new": "SalesView"}]
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
 * Multiple entries in `renameSymbols` let you rename several identifiers
 * declared in the same file in one op (e.g. component + its `Props` type +
 * an internal helper).
 */
export type RefactorOpInput = RefactorOpShort | RefactorOpFull;

export type RefactorOpShort = [from: string, to: string];

export interface RefactorOpFull {
    from: string;
    to: string;
    renameSymbols?: Array<{old: string; new: string}>;
}

export interface OpsInput {
    ops: RefactorOpInput[];
}

/** After normalization — uniform internal shape. */
export interface RefactorOp {
    from: string;
    to: string;
    /** Always present, possibly empty. */
    renameSymbols: Array<{old: string; new: string}>;
}

/** Augmented form after preflight: absolute paths, classified, indexed. */
export interface NormalizedOp extends RefactorOp {
    /** Index in the original input array (for stable error messages). */
    index: number;
    /** Resolved absolute source path. */
    fromAbs: string;
    /** Resolved absolute target path. */
    toAbs: string;
    /** True if `from`/`to` are a directory; false if a file. */
    isFolder: boolean;
    /** True when source and target sit in the same parent directory. */
    sameParent: boolean;
}

/** @deprecated kept temporarily for callers that still expect the legacy single-symbol shape. */
export interface NormalizedOpLegacy extends Omit<NormalizedOp, 'renameSymbols'> {
    renameSymbol?: {old: string; new: string};
}

/** One level of the execution plan; ops within the same level are mutually independent. */
export interface PlanLevel {
    level: number;
    ops: NormalizedOp[];
}
