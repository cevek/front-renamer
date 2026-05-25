/**
 * Build the execution plan: a sequence of phases where each phase contains
 * ops that are mutually independent (can run in parallel).
 *
 * Dependency rules between two distinct ops A and B (paths are absolute):
 *
 *   1. B.from is descendant of A.from  ⇒  B before A
 *      (Process the inner thing first; A then moves the whole parent including
 *      whatever B did inside it.)
 *
 *   2. B.from is descendant of A.to    ⇒  A before B
 *      (B references a location that doesn't exist until A produces it.)
 *
 *   3. A.from is descendant of B.from  ⇒  A before B  (symmetric to #1)
 *   4. A.from is descendant of B.to    ⇒  B before A  (symmetric to #2)
 *
 *   5. B.to is descendant of A.from    ⇒  B before A
 *      (B's target sits inside something A will then move away — that's
 *      actually fine logically, but ts can't see it: process B's edits before
 *      the parent gets relocated.)
 *
 * Identifier renames (renameSymbol) are NOT ordered by physical move — they're
 * applied at apply-time against the in-memory snapshot before any moves are
 * committed to disk. So they don't affect the DAG.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {NormalizedOp, PlanLevel} from './schema.js';

function isDescendant(child: string, parent: string): boolean {
    if (child === parent) return false;
    const rel = path.relative(parent, child);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function existedAtInit(absPath: string): boolean {
    try {
        fs.statSync(absPath);
        return true;
    } catch {
        return false;
    }
}

export interface PlanResult {
    levels: PlanLevel[];
    cycles: Array<{a: NormalizedOp; b: NormalizedOp}>;
}

export function buildPlan(ops: NormalizedOp[]): PlanResult {
    // Build adjacency: edge u → v means u must run BEFORE v.
    const edges = new Map<number, Set<number>>();
    const inDegree = new Map<number, number>();
    for (const op of ops) {
        edges.set(op.index, new Set());
        inDegree.set(op.index, 0);
    }

    const addEdge = (uIdx: number, vIdx: number) => {
        const set = edges.get(uIdx)!;
        if (!set.has(vIdx)) {
            set.add(vIdx);
            inDegree.set(vIdx, (inDegree.get(vIdx) ?? 0) + 1);
        }
    };

    // Cache: which paths exist at init? (used to disambiguate chain vs vacate).
    const initExists = new Map<string, boolean>();
    const checkInit = (p: string): boolean => {
        let v = initExists.get(p);
        if (v === undefined) {
            v = existedAtInit(p);
            initExists.set(p, v);
        }
        return v;
    };

    for (const a of ops) {
        for (const b of ops) {
            if (a === b) continue;

            // ---------- Extract-specific ordering ----------
            // Two extract ops merging into the SAME target file run sequentially —
            // the first one creates/uses the file, the second appends to it.
            if (
                a.kind === 'extract' &&
                b.kind === 'extract' &&
                a.toAbs === b.toAbs &&
                a.index < b.index
            ) {
                addEdge(a.index, b.index);
            }
            // An extract from a source file must run BEFORE any move op whose `from`
            // is that source file (so the source has fewer symbols when it moves).
            if (a.kind === 'extract' && b.kind === 'move' && a.fromAbs === b.fromAbs) {
                addEdge(a.index, b.index);
            }
            // If an extract's source is the TARGET of a move (extract from a file
            // we're moving INTO place), the move must land first.
            if (a.kind === 'move' && b.kind === 'extract' && a.toAbs === b.fromAbs) {
                addEdge(a.index, b.index);
            }
            // Chain of extracts: extract1 creates a file, extract2 lifts a symbol
            // back out of it. The producer must run first.
            if (a.kind === 'extract' && b.kind === 'extract' && a.toAbs === b.fromAbs) {
                addEdge(a.index, b.index);
            }
            // If a move's target sits INSIDE the source dir of an extract, ensure
            // the extract first so its synthetic file isn't dragged unexpectedly.
            if (
                a.kind === 'extract' &&
                b.kind === 'move' &&
                (a.toAbs === b.fromAbs ||
                    a.toAbs.startsWith(b.fromAbs + path.sep))
            ) {
                addEdge(a.index, b.index);
            }
            // ---------- The remaining rules concern move ops on paths. ----------
            if (a.kind === 'extract' || b.kind === 'extract') continue;

            // 1. B.from descendant of A.from → B before A
            if (isDescendant(b.fromAbs, a.fromAbs)) addEdge(b.index, a.index);
            // 2. B.from descendant of A.to → A before B
            if (isDescendant(b.fromAbs, a.toAbs)) addEdge(a.index, b.index);
            // 3. A.to === B.from →
            //    - if B.from existed at init: B must vacate before A overwrites (B before A).
            //    - else: chain — A creates the path, B consumes it (A before B).
            if (a.toAbs === b.fromAbs) {
                if (checkInit(b.fromAbs)) addEdge(b.index, a.index);
                else addEdge(a.index, b.index);
            }
            // 4. A.from === B.to →
            //    - if A.from existed at init: A must vacate before B writes there (A before B).
            //    - else: A.from is created by B (chain): B before A.
            if (a.fromAbs === b.toAbs) {
                if (checkInit(a.fromAbs)) addEdge(a.index, b.index);
                else addEdge(b.index, a.index);
            }
            // 5. B.to descendant of A.from → B before A
            if (isDescendant(b.toAbs, a.fromAbs)) addEdge(b.index, a.index);
        }
    }

    // Kahn topo sort. Group by level: pop everything with inDegree 0 simultaneously.
    const remaining = new Map(inDegree);
    const opByIndex = new Map(ops.map((o) => [o.index, o]));
    const levels: PlanLevel[] = [];
    let levelNum = 0;

    while (remaining.size > 0) {
        const ready: number[] = [];
        for (const [idx, deg] of remaining) {
            if (deg === 0) ready.push(idx);
        }
        if (ready.length === 0) break;
        const levelOps = ready.map((i) => opByIndex.get(i)!).sort((a, b) => a.index - b.index);
        levels.push({level: levelNum++, ops: levelOps});
        for (const idx of ready) {
            remaining.delete(idx);
            for (const out of edges.get(idx)!) {
                remaining.set(out, (remaining.get(out) ?? 1) - 1);
            }
        }
    }

    // If any ops remain, they form a cycle. Collect the offending pairs.
    const cycles: Array<{a: NormalizedOp; b: NormalizedOp}> = [];
    for (const idx of remaining.keys()) {
        const opA = opByIndex.get(idx)!;
        for (const otherIdx of edges.get(idx)!) {
            if (remaining.has(otherIdx)) {
                cycles.push({a: opA, b: opByIndex.get(otherIdx)!});
            }
        }
    }

    return {levels, cycles};
}

export function summarizePlan(plan: PlanResult, verbose = false): string {
    const lines: string[] = [];
    lines.push(`Plan: ${plan.levels.length} sequential phase(s)`);
    let totalOps = 0;
    for (const lvl of plan.levels) {
        totalOps += lvl.ops.length;
        lines.push(`  phase ${lvl.level}: ${lvl.ops.length} parallel op(s)`);
        if (verbose) {
            for (const op of lvl.ops.slice(0, 5)) {
                lines.push(`     #${op.index}: ${op.from} → ${op.to}`);
            }
            if (lvl.ops.length > 5) lines.push(`     …and ${lvl.ops.length - 5} more`);
        }
    }
    lines.push(`Total ops: ${totalOps}`);
    if (plan.cycles.length > 0) {
        lines.push(`⚠ Cycles detected (${plan.cycles.length} pair(s)):`);
        for (const {a, b} of plan.cycles.slice(0, 10)) {
            lines.push(`    op#${a.index} (${a.from} → ${a.to}) ↔ op#${b.index} (${b.from} → ${b.to})`);
        }
    }
    return lines.join('\n');
}
