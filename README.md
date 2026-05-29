# front-renamer

**Restructure a React/TypeScript codebase in seconds.**

Declare where every file should live, run one command, ship a clean tree —
imports rewritten, identifiers renamed, history preserved, formatter applied.

```bash
npx front-renamer ops.json --apply
```

## What it does

You write JSON describing what should be where. The tool:

- Moves every file and folder (`git mv` — history survives)
- Rewrites every `import` across the project, both `@/`-aliased and relative
- Renames matching identifiers (and their references) via the TypeScript LS
- Carries sibling `.module.scss` / `.module.css` along
- Extracts top-level symbols into new files via TS LS "Move to a new file"
- Co-extracts the CSS classes that block uses (safe-only)
- Type-checks before AND after; refuses to start if the project already
  fails, refuses if the git tree is dirty
- Runs the project's prettier over every touched file

Real-world: **129 ops, 62 applied, post-typecheck clean, ~32 s** end-to-end
including two full project type-checks and prettier.

## Install / run

```bash
# one-off
npx front-renamer ops.json

# dev dependency
pnpm add -D front-renamer
pnpm exec front-renamer ops.json --apply
```

```bash
# preview (dry-run; nothing touches disk)
front-renamer ops.json

# apply for real
front-renamer ops.json --apply

# inline JSON instead of a file
front-renamer '[["src/old", "src/new"]]' --apply
```

## Writing ops

Each entry is a short tuple, a full move-object, or an extract-object.
Mix freely.

```json
[
  ["src/components/Dashboard", "src/features/dashboard/DashboardView"],

  {
    "from": "src/components/Inputs",
    "to":   "src/components/forms/fields"
  },

  {
    "from": "src/components/Widget",
    "to":   "src/features/widgets/Widget",
    "renameSymbols": [
      {"old": "Widget", "new": "WidgetCard"},
      {"old": "WidgetProps", "new": "WidgetCardProps"}
    ]
  },

  {
    "extract": "Header",
    "from":    "src/Sales/Sales.tsx",
    "to":      "src/Sales/Header/Header.tsx",
    "css":     "copy-safe"
  }
]
```

**Conventions**

- Paths are project-relative (or relative to `--cwd`).
- Extension → file. No extension → folder.
- Tuple/object without `renameSymbols` → auto-detects ONE rename from
  the basename diff. Pass `[]` to suppress, pass the explicit list for
  multiple identifiers.

**Globs and templates**

```json
[["src/components/ds/*", "src/components/"]]
```

`*` must be in the final segment. Templates on `to`:
`"src/features/{stem|strip:Section|kebab}/{stem|strip:Section}View.tsx"`
with filters `lc`, `uc`, `kebab`, `strip:Suffix`, `stripPrefix:Prefix`.

**Extract templates.** For a folder-per-component layout you don't have to
spell out `to` per op — pass `--extract-to <pattern>`:

```bash
front-renamer ops.json --extract-to "{dir}/{symbol}/{symbol}.tsx" --apply
```

Extra vars in this context: `{symbol}` (the extract name) and `{dir}`
(project-relative directory of `from`). An op's own `to` can also be a
template literal — same vars, applied per-op.

**Extract caveats.** Extract delegates to the TS language service.
If TS can't perform "Move to a new file" / "Move to file" for a symbol
(LS internal assertion, no edits produced, etc.) the op fails cleanly
with a grouped report — extract that symbol manually. The tool never
invents its own extract logic.

**CSS co-extract (`"css": "copy-safe"`).** The tool walks the source's
sibling stylesheet, figures out which classes the extracted block uses,
moves the **provably safe** ones into a fresh stylesheet next to the
extracted file. Anything ambiguous (compound selectors, `@include`,
`@extend`, value interpolation) stays in the original — references get
rewritten to `sLegacy.X`. A per-class moved/left-behind report prints
at the end. **Diff and visual-test before merging.**

## CLI

```
front-renamer <ops.json | inline-json> [options]

  --apply              Commit changes to disk (default is dry-run).
  --dry                Force dry-run (default).
  --cwd <path>         Project root. Default: cwd.
  --tsconfig <path>    Autodetect tsconfig.app.json → tsconfig.json.
  --src <path>         Source directory. Default: <cwd>/src.
  --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
  --no-rollback        Disable auto-rollback on post-typecheck failure.
  --no-prune           Don't remove empty dirs after moves.
  --strict             Hard-fail on first op error (default: continue
                       and collect failures into a final report).
  --extract-to <pat>   Template applied to extract ops that omit "to"
                       (e.g. "{dir}/{symbol}/{symbol}.tsx").
  --report-json <path> Machine-readable run report (see below).
  --rewrite-paths-in   Also substitute path refs in non-TS files (HTML,
                       config, JSON, Markdown). Repeatable.
  -h, --help
```

## How it stays safe

- **Refuses dirty git tree in `--apply`.** Commit or stash first — your
  uncommitted work would be entangled with the tool's edits and rollback
  would wipe it.
- **Pre-typecheck** — bails if the project already has TS errors so
  post-typecheck failures are clearly attributable to the refactor.
- **Post-typecheck** runs against the **in-memory** post-batch state in
  dry-run (no commit needed to know if the result compiles).
- **Auto-rollback** on post-typecheck failure in apply: `git reset --hard
  <snapshot> && git clean -fd`. Armed only when the tree was clean at
  start.
- **Dry-run is zero-write.** The TS language service runs against a
  VFS-aware host — no `.module.scss.tmp` flickers in your IDE.
- **Schema validation runs first.** A typo like `from1` fails in
  milliseconds with `did you mean "from"?` instead of an opaque crash
  fifteen seconds into a type-check.

## Output

```
front-renamer (dry-run)
  root      /path/to/project
  ops       ops.json
  tsconfig  tsconfig.json
  ts        6.0.3 (project)         ← resolved from project's node_modules

✓ 129 op(s) validated
✓ pre-typecheck clean
✓ plan: 5 phase(s)
✓ applied 62/129 op(s) in-memory
✓ imports rewritten in 68 file(s)
✓ prettier 3.8.3 (122 file(s) formatted)
· dry-run — not writing to disk
✓ post-typecheck clean (in-memory overlay)

=== summary ===
phases:           5
ops total:        129
  ✓ applied:      62  (moves: 0, moves+rename: 0, extracts: 62)
  ✗ failed:       67
files with edits: 122
diff:             /tmp/front-renamer-2026-05-29T13-38-37Z.patch

=== ✓ applied ops (62) ===
  extracts (62):
    op#3   toTitleCase       components/.../AutoStatusPill.tsx → helpers.ts
    op#5   FormBody          components/.../FormLayout.tsx     → FormBody.tsx
    ...

=== ✗ failed ops (67, 1 cause) ===
  TS LS internal assertion ("Expected symbol to be a module") — extract these manually — 67 op(s):
    op#0   IconDropdown      components/.../AppearancePicker.tsx → IconDropdown.tsx
    ...
```

Diff is written to one temp file in unified format (`git diff`-style
sections per file). The console shows the path, not the content.

## Machine-readable report

`--report-json <path>` writes a stable JSON shape next to the run.
Useful for CI gates and for generating a follow-up ops.json from only
the failed entries.

```bash
front-renamer ops.json --report-json run.json
```

Then in CI:

```bash
# fail the build if anything didn't apply
[ "$(jq '.ops.failed' run.json)" = "0" ] || exit 1

# regenerate ops.json containing only the failed extracts
jq '[.failed[] | select(.kind == "extract")
                 | {extract: .symbol, from, to}]' run.json > retry.json
```

Top-level keys: `version`, `mode`, `startedAt`, `elapsedMs`, `exitCode`,
`project` (root / tsconfig / ts / prettier metadata), `ops` (counts +
breakdown by kind), `applied[]`, `failed[]` (with `category`, `error`,
`context`, `docs`), `warnings[]`, `imports`, `prettier`, `cssReports[]`,
`diff`, `rollback`.

## What's resolved from the project

`typescript`, `prettier`, and the entire `tsconfig` (incl. `paths` /
`baseUrl`) are read from the project itself — version, config, lib.d.ts,
formatter style. The bundled `typescript` is only a fallback when the
project has none installed. Header line `ts  X.Y.Z (project|bundled)`
tells you which one is active.

## What it deliberately doesn't do

- **No code transforms.** Not a codemod. Use jscodeshift / ts-morph for
  that.
- **No file splits or merges** beyond `extract`. Moves are unit moves.
- **No string/comment/JSX-text rewrites.** `"OldName"` in a string stays.
- **No dynamic-import resolution.** Only string-literal specifiers.
- **No JS-only repos.** A tsconfig is required.
- **No external config updates.** `knip.json`, ESLint, Vite aliases,
  package.json scripts hardcoding paths — yours to update.
- **No git commit.** Uses `git mv` so history survives, but the commit
  message is your call.
- **No cross-package moves in monorepos** (yet). Per-package refactors
  work — point `--cwd` at the package.

## Programmatic use

```ts
import {loadProject, normalizeOps, buildPlan, Engine} from 'front-renamer';

const project = loadProject(process.cwd());
const ops = normalizeOps([['src/Foo', 'src/features/foo/Foo']], project.root);
const plan = buildPlan(ops);
const engine = new Engine(project);
engine.applyToVFS(plan.levels);
engine.rewriteAllImports();
engine.commit();
```

## License

MIT.
