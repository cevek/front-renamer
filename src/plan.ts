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
import * as path from 'node:path';
import type {NormalizedOp, PlanLevel} from './schema.js';

function isDescendant(child: string, parent: string): boolean {
    if (child === parent) return false;
    const rel = path.relative(parent, child);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
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

    for (const a of ops) {
        for (const b of ops) {
            if (a === b) continue;
            // 1. B.from descendant of A.from → B before A
            if (isDescendant(b.fromAbs, a.fromAbs)) addEdge(b.index, a.index);
            // 2. B.from descendant of A.to → A before B
            if (isDescendant(b.fromAbs, a.toAbs)) addEdge(a.index, b.index);
            // 2b. A.to === B.from → A before B  (chain: A produces what B consumes)
            if (a.toAbs === b.fromAbs) addEdge(a.index, b.index);
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
