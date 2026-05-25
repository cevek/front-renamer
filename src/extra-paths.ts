/**
 * Rewrite path-shaped string-literals in non-TS files (index.html, vite.config,
 * package.json scripts, …) after a refactor. For each `(oldPath → newPath)`
 * relocation from the VFS tree, scan every file matched by user-supplied globs
 * and substitute literal occurrences of `oldPath` (POSIX form, both quoted and
 * unquoted).
 *
 * Conservative: only replaces paths that look like project-relative paths —
 * either start with `src/`, with `./` / `../`, or with `/` (root-relative).
 * Avoids accidental hits on partial word matches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {VFSTree} from './vfs.js';

/** Minimal glob matcher (supports `*`, `**`, character matching).
 *  Anchored to the project root. */
function globToRegex(pattern: string): RegExp {
    // Escape regex metacharacters except `*`
    let src = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                src += '.*';
                i++;
                if (pattern[i + 1] === '/') i++; // consume trailing slash of **
            } else {
                src += '[^/]*';
            }
        } else if ('.+?^$()[]{}|\\'.includes(c)) {
            src += '\\' + c;
        } else {
            src += c;
        }
    }
    return new RegExp('^' + src + '$');
}

function expandGlob(root: string, pattern: string): string[] {
    // Absolute? Use as-is. Otherwise anchor against project root.
    const abs = path.isAbsolute(pattern) ? pattern : path.join(root, pattern);
    // Static (no glob char) fast-path.
    if (!abs.includes('*')) {
        return fs.existsSync(abs) ? [abs] : [];
    }
    const re = globToRegex(abs);
    const out: string[] = [];
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (re.test(full)) out.push(full);
        }
    };
    walk(root);
    return out;
}

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', 'coverage',
    '.next', '.turbo', '.cache',
]);

/** Convert a list of glob patterns into an absolute file list. */
export function resolveExtraPaths(root: string, globs: string[]): string[] {
    const seen = new Set<string>();
    for (const g of globs) {
        for (const f of expandGlob(root, g)) seen.add(f);
    }
    return Array.from(seen);
}

/**
 * Build a list of (oldRel, newRel) tuples from the VFS tree. Skips directories
 * because file-level entries already cover every actually-relocated path; the
 * dir entries would only widen the chance of partial matches.
 */
function collectRelocations(tree: VFSTree, root: string): Array<{oldRel: string; newRel: string}> {
    const out: Array<{oldRel: string; newRel: string}> = [];
    for (const node of tree.iterFiles()) {
        const initial = node.initialPath();
        const current = node.currentPath();
        if (initial !== current) {
            out.push({
                oldRel: path.relative(root, initial).split(path.sep).join('/'),
                newRel: path.relative(root, current).split(path.sep).join('/'),
            });
        }
    }
    return out.sort((a, b) => b.oldRel.length - a.oldRel.length);
}

interface RewriteHit {
    file: string;
    replaced: number;
}

/**
 * Apply path substitutions to every extra file. Returns per-file hit count and
 * a flag indicating whether any file actually changed.
 */
export function rewriteExtraPaths(
    files: string[],
    tree: VFSTree,
    root: string,
): {hits: RewriteHit[]; changed: number} {
    const relocations = collectRelocations(tree, root);
    if (relocations.length === 0) return {hits: [], changed: 0};

    // Boundary policy:
    //  - LEFT  side: start-of-string, quote (`'"` `` ` ``), whitespace, `=,(`,
    //                `<`, or a directory separator that EITHER starts a root-
    //                relative URL (e.g. `/src/main.tsx` in HTML) OR is the very
    //                start of the literal we want to match. We exclude embedded
    //                `/` between two ordinary chars so `"../src/main.tsx"` does
    //                NOT lop off `src/main.tsx` and leave dangling `../`.
    //  - RIGHT side: end-of-string OR a non-path closer.
    //
    // Implementation: left boundary is either a "clean" punctuation char OR a
    // `/` immediately preceded by quote/start. We can't fully express that in
    // one regex with lookbehinds reliably across runtimes, so we match against
    // BOTH the path AND the path-with-leading-slash, with the latter requiring
    // a clean left boundary too.
    const cleanLeft = `(?<=^|["'\`\\s=,(\\[<>])`;
    const tail = `(?=["'\`\\s=,)\\]>?:&]|$)`;
    const escapedRegexes: Array<{re: RegExp; replacement: string}> = [];
    for (const {oldRel, newRel} of relocations) {
        // Match `…/<oldRel>` ONLY when the leading slash itself is at a clean
        // boundary (root-relative URL or freshly-quoted path).
        escapedRegexes.push({
            re: new RegExp(cleanLeft + '/' + escapeRegex(oldRel) + tail, 'g'),
            replacement: '/' + newRel,
        });
        // Match bare `<oldRel>` at a clean boundary.
        escapedRegexes.push({
            re: new RegExp(cleanLeft + escapeRegex(oldRel) + tail, 'g'),
            replacement: newRel,
        });
    }

    const hits: RewriteHit[] = [];
    let changed = 0;
    for (const file of files) {
        let content: string;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        let next = content;
        let replaced = 0;
        for (const {re, replacement} of escapedRegexes) {
            next = next.replace(re, () => {
                replaced++;
                return replacement;
            });
        }
        if (replaced > 0) {
            fs.writeFileSync(file, next);
            hits.push({file, replaced});
            changed++;
        }
    }
    return {hits, changed};
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
