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
- Extracts top-level symbols into new files via TS LS "Move to a new file";
  retries through a patched LS (`@cevek/typescript-extract-refactor-fix`)
  when stock TS hits its `Expected symbol to be a module` assertion
- Co-extracts the CSS classes that block uses (safe-only)
- Type-checks before AND after; refuses to start if the project already
  fails, refuses if the git tree is dirty in `--apply`
- Runs the project's prettier over every touched file
- Writes a unified-diff `.patch` of the full result to a temp file

Real-world: **129 ops, 129 applied (67 rescued via the patched TS LS),
post-typecheck clean, ~50 s** end-to-end including two full project
type-checks and prettier across ~310 files.

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
If TS can't perform "Move to a new file" / "Move to file" for a symbol,
the tool retries through a patched LS
(`@cevek/typescript-extract-refactor-fix`) that addresses the well-known
`Expected symbol to be a module` assertion. Rescued ops appear in the
stage log as `↻ N rescued via patched TS LS` and are counted in the
report under `ops.rescuedByFallback`. If the patched LS also can't
handle the shape, the op fails cleanly with a grouped report — extract
that symbol manually. The tool never invents its own extract logic.

**Auto-coerce `.ts` → `.tsx`.** Extract ops whose body contains JSX but
whose `to` ends in `.ts` get rewritten to `.tsx` automatically — your
ops.json doesn't have to peek inside the file to know it returns JSX.
The stage log lists every coerced op (`↻ auto-coerced N op(s) …`) and
the JSON report carries them under `coercions[]`. Grouping is per-
destination: if two ops target the same `helpers.ts` and only one has
JSX, BOTH get coerced so they still merge into the same file.

**CSS co-extract (`"css": "copy-safe"`).** The tool walks the source's
sibling stylesheet, figures out which classes the extracted block uses,
moves the **provably safe** ones into a fresh stylesheet next to the
extracted file. Anything ambiguous (compound selectors, `@include`,
`@extend`, value interpolation) stays in the original — references get
rewritten to `sLegacy.X`. A per-class report prints at the end with
short codes (`USED` / `NO-RULE` / `COMPOUND` / `NESTED` / `AT-RULE` /
`SASS-VAR` / `EXTEND` / `NEST-PARENT` / `ALIAS-IMP`) and a one-line
legend at the bottom. **Diff and visual-test before merging.**

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
↻ auto-coerced 5 op(s) .ts → .tsx (body contains JSX)
    op#37  content        features/.../helpers.ts → helpers.tsx
    op#40  renderWebsite  features/.../helpers.ts → helpers.tsx
    ...
✓ pre-typecheck clean
✓ plan: 5 phase(s)
✓ applied 129/129 op(s) in-memory
  ↻ 67 rescued via patched TS LS
✓ imports rewritten in 74 file(s)
✓ prettier 3.8.3 (314 file(s) formatted)
✓ diff written to /tmp/front-renamer-2026-05-29T13-38-37Z.patch
✓ post-typecheck clean (in-memory overlay)

=== summary ===
phases:           5
ops total:        129
  ✓ applied:      129  (moves: 0, moves+rename: 0, extracts: 129)
  ✗ failed:       0
files with edits: 314
CSS classes:      330 across 64 stylesheet(s)
  ✓ moved:        233
  ✗ left behind:  97

=== ✓ applied ops (129) ===
  extracts (129):
    op#3   toTitleCase       components/.../AutoStatusPill.tsx → helpers.ts
    op#5   FormBody          components/.../FormLayout.tsx     → FormBody.tsx
    ...

=== CSS co-extract ===

  components/.../AppearancePicker.module.scss → ColorDropdown.module.scss
    moved: .swatch  .chevron  .grid
    left:  .trigger NESTED  .menu COMPOUND  .tile NO-RULE

  legend:
    NESTED    rule has nested child rules
    COMPOUND  appears in a compound selector elsewhere
    NO-RULE   no matching CSS rule found

✓ done (50.2s)  (log: /tmp/front-renamer-log-2026-05-29T...log)
```

The full console output is mirrored to a temp `.log` file when
`--report-json` isn't set — path printed alongside `done` so you can
re-read a run without rerunning. Diff is written to a separate temp
`.patch` file in unified format (`git diff`-style sections per file).
The console shows the paths, never the content.

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
`project` (root / tsconfig / ts / prettier metadata), `ops` (counts —
including `rescuedByFallback` — and breakdown by kind), `applied[]`,
`failed[]` (with `category`, `error`, `context`, `docs`), `warnings[]`,
`coercions[]` (auto-coerced `.ts` → `.tsx` records), `imports`, `prettier`
(with per-file `failed[]`), `css` (aggregate `moved`/`leftBehind`/`sheets`),
`cssReports[]` (with `leftBehind[].code`/`detail`/`reason`), `diff`,
`rollback`.

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
