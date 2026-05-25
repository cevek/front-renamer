# front-renamer

**Restructure your React/TypeScript codebase in seconds, not days.**

Declare where every file should live, run one command, ship a clean tree —
imports rewritten, identifiers renamed, history preserved.

```bash
npx front-renamer ops.json --apply
```

---

## The problem

Your folder structure stopped scaling six months ago. You know exactly how it
should look. But getting there means:

- moving **hundreds of files** across the repo
- updating **thousands of imports** in lockstep
- renaming components and their props/hooks/helpers consistently
- keeping `git log --follow` intact so history doesn't die
- doing all of it without breaking TypeScript for a single commit in between

That's a one-to-three-day project for a senior engineer. So the structure stays
broken. New code piles on top of the bad layout. The cost compounds.

IDE rename works one symbol at a time. Find-and-replace ruins your imports.
`ts-morph` lets you script it — but only after you become a ts-morph expert.
None of these scale to "rearrange the whole repo this afternoon."

## What front-renamer does

You write a JSON file that says **what should be where**:

```json
[
  ["src/components/Dashboard", "src/features/dashboard/DashboardView"],
  ["src/components/UserSettings", "src/features/users/UserSettings"],
  ["src/components/Button", "src/components/ui/Button"],
  ["src/components/Spinner.tsx", "src/components/ui/Loader.tsx"]
]
```

Run it:

```bash
npx front-renamer ops.json --apply
```

Done. The tool:

- Moves every file and folder to its new home
- Rewrites every `import` in your entire codebase — both `@/`-aliased and
  relative — to the new locations
- Renames the matching component identifier (and its `Props`, and any
  other declarations you list) across every reference in the project
- Carries sibling `.module.scss` along for the ride
- Uses `git mv` so `git log --follow` still works tomorrow
- Type-checks before AND after, refusing to run if your repo isn't already
  green, and bailing loudly if something it did breaks the build

Real-world test: **126 ops, 769 file relocations, 424 files with rewritten
imports — ~15 seconds end-to-end including two full project type-checks.**

## Why declarative

You don't have to learn an API. You don't have to write code. You don't have to
remember whether `move()` updates aliased imports (it doesn't, and that's where
the day disappears).

You describe the destination. The tool computes the path.

## Quick start

> **Before you run `--apply`, commit or stash everything in your working tree.**
> The tool rewrites hundreds of files in one shot. If anything looks off
> afterwards (post-typecheck failure, missed import, surprise file move), the
> only painless rollback is `git restore .` + `git clean -fd`. That only works
> if the pre-run state was clean.

```bash
# Preview what would change — no disk writes
npx front-renamer ops.json --dry

# Apply for real
npx front-renamer ops.json --apply
```

Install as a dev dependency:

```bash
pnpm add -D front-renamer
pnpm exec front-renamer ops.json --apply
```

## Writing ops

Ops are a JSON array. Each entry is either a **short tuple** or a **full
object**. Mix them freely:

```json
[
  ["src/components/Dashboard", "src/features/dashboard/DashboardView"],

  {
    "from": "src/components/Inputs",
    "to": "src/components/forms/fields"
  },

  {
    "from": "src/components/Widget",
    "to": "src/features/widgets/Widget",
    "renameSymbols": [
      {"old": "Widget", "new": "WidgetCard"},
      {"old": "WidgetProps", "new": "WidgetCardProps"},
      {"old": "useWidget", "new": "useWidgetCard"}
    ]
  }
]
```

### How rename detection works

When you write a tuple or a full object **without** `renameSymbols`, the tool
checks: did the basename change? If yes and the file (or main `<basename>.tsx`
inside a folder) exists, it renames that identifier and its references for free.

When you need finer control — multiple identifiers in one file, or a rename
that the basename can't express — list them explicitly under `renameSymbols`.

Pass `"renameSymbols": []` to suppress autodetection.

### Extracting a symbol into a new file

Lift a top-level component, hook, or type out of a busy file:

```json
{
  "extract": "Header",
  "from": "src/Sales/Sales.tsx",
  "to":   "src/Sales/Header/Header.tsx"
}
```

Multiple extracts into the same target are honoured — first creates the file,
each subsequent one merges in.

> **Extract relies entirely on the TypeScript language service.** If TS itself
> can't perform "Move to a new file" / "Move to file" for a given symbol —
> common triggers: complex alias imports the LS can't fully resolve, the file
> has only one top-level statement, or a deep TS LS internal assertion — the
> tool will refuse the op with a clear message. **In that case, delete the op
> from your JSON and extract the symbol by hand.** The tool will not invent
> its own refactor logic; it would silently corrupt the file.

#### Co-extracting CSS Modules

Set `"css": "copy-safe"` on an extract op:

```json
{
  "extract": "Header",
  "from": "src/Sales/Sales.tsx",
  "to":   "src/Sales/Header/Header.tsx",
  "css":  "copy-safe"
}
```

The tool walks the source file's sibling `.module.scss`/`.module.css`, figures
out which classes the extracted block uses, and moves the **provably safe** ones
into a fresh stylesheet next to the extracted file. Anything that doesn't pass
the safety bar stays in the original sheet; references to those classes get
rewritten to `sLegacy.X` (with an auto-injected legacy import) so the extracted
file still compiles. The tool prints a per-class report:

```
--- CSS co-extract ---
  src/Sales/Sales.module.scss  →  src/Sales/Header/Header.module.scss
    moved (safe): .title, .icon
    left behind (manual review):
      .body   — class appears in a compound selector elsewhere
      .label  — uses @include mixin
```

> **Safe co-extract is conservative but not magic.** Stylesheets vary wildly —
> `@use`/`@import` chains, parent selectors, `@extend %placeholder`, deeply
> nested media queries, value interpolation through Sass functions, mixin
> arguments referencing the outer scope. The tool refuses to move anything it
> can't reason about cleanly, but a handful of micro-cases (CSS-in-JS shapes
> we don't recognise, comment-attachment quirks across postcss versions,
> specifier resolution through tsconfig paths in non-relative imports) can
> still produce a stylesheet that **looks** right but breaks at runtime.
> **Always diff the output, eyeball the moved/left-behind report, and run your
> visual regression tests before merging.** A handful of leftover unsafe
> classes is the expected outcome — that's the design.

### Path conventions

- Paths are relative to the project root (or `--cwd <path>`).
- Extension on the path means **file**. No extension means **folder**.

## CLI

```
front-renamer <ops.json> [options]

  --apply              Commit changes to disk (default is dry-run).
  --dry                Force dry-run (default).
  --cwd <path>         Project root. Default: current working directory.
  --tsconfig <path>    tsconfig file. Default: autodetect tsconfig.app.json
                       → tsconfig.json.
  --src <path>         Source directory to scan. Default: <cwd>/src.
  --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
  --no-rollback        Disable auto-rollback on post-typecheck failure.
                       (Default: rollback ON when the working tree was clean.)
  --no-prune           Don't remove empty directories left behind by moves.
  --quiet              Reduce output to errors and final status.
  -h, --help           Show this help.
```

## What it handles

- **Folder moves** with arbitrary depth — children, grandchildren, sibling
  styles, everything follows.
- **Folder renames** in place (`PatientRecord` → `PatientRecordView`).
- **File moves** — wrap a loose file into its own folder, drop it into a
  shared `helpers/` dir, anything.
- **Identifier renames** across the entire project via the TypeScript
  language service. Default-import local bindings get rebound too.
- **Sibling assets** — `.module.scss` / `.module.css` next to a `.tsx`
  travel with it automatically.
- **Aliased imports** (`@/components/Foo`) — resolved via `tsconfig.paths`
  and rewritten alongside relative imports.
- **Chains** — `A → B`, then later `B → C` somewhere else in the same ops
  file. The tool builds a dependency graph and applies in the right order.
- **Swap-via-temp** — pass two folders through a temporary name to exchange
  them: `A → __tmp`, `B → A`, `__tmp → B`. Planner figures out the order.
- **Glob sources** — `["src/components/ds/*", "src/components/"]` expands to
  one op per matched child. `*` must be in the final path segment.
- **Templated destinations** — variables `{name}`, `{stem}`, `{ext}`,
  `{parent}` plus filters `lc`, `uc`, `kebab`, `strip:Suffix`,
  `stripPrefix:Prefix`. Example pattern:
  `"src/features/{stem|strip:Section|kebab}/{stem|strip:Section}View.tsx"`.
- **Path rewrites in non-TS files** — pass `--rewrite-paths-in <glob>` for
  files like `index.html` or `vite.config.ts` to substitute path references
  to anything you've moved.
- **Empty directory cleanup** — recursive prune after commit; `--no-prune`
  to keep them.
- **Auto-rollback** — when the working tree is clean at start, a failed
  post-typecheck is reverted via `git reset --hard && git clean -fd`.
- **Random input order** — your ops don't need to be sorted. The planner
  topologically sorts them and reports parallel-safe phases.

## What it doesn't do

This is a structural tool, not a codemod. It deliberately stays out of code
semantics.

- **It doesn't decide the structure for you.** You declare the destination.
  The tool applies it.
- **It doesn't transform code.** No "convert all class components to hooks",
  no "swap library A for library B". If you want jscodeshift-style rewrites,
  run them separately.
- **It doesn't split or merge files.** Files move as units. Extracting one
  export into a new file, or combining two files into one — out of scope.
- **It doesn't touch strings, comments, or JSX text.** `"OldName"` written as
  a string literal stays a string literal. Same for log messages, docs,
  comments mentioning old names.
- **It doesn't run formatters.** Run Prettier, ESLint, oxlint, etc.
  separately after `--apply` if your team cares about quote style or
  whitespace conventions.
- **It doesn't update external config files.** `knip.json`, ESLint configs,
  Vite aliases, `package.json` scripts that hardcode old paths — those are
  yours to update. Only `tsconfig.paths` is read (to resolve `@/`-style
  aliases).
- **It doesn't commit to git.** It uses `git mv` for relocations so history
  is preserved, but writing the commit (and its message) is your job.
- **It doesn't resolve dynamic imports.** `import(someVariable)` and
  `require(someExpr)` are invisible — only string-literal specifiers get
  rewritten.
- **It doesn't work without TypeScript.** A `tsconfig.json` (or
  `tsconfig.app.json`) is required. JS-only repos aren't supported.
- **It doesn't rename non-exported locals.** Identifier renames target
  declarations referenced across files. A function-local variable named the
  same as your component stays untouched (which is what you want).
- **It doesn't auto-attach non-TS assets by import graph.** Sibling
  `.module.scss` / `.module.css` next to a moved `.tsx` follow automatically.
  Anything else (regular `.css`, images, JSON fixtures, MDX) needs an
  **explicit op** — which works fine: `["src/index.css", "src/styles/global.css"]`
  moves the file and rewrites the `import "./index.css"` reference too.
  The tool doesn't try to guess from the import graph which assets should
  travel along.

## Monorepos

front-renamer is built around a single TypeScript project: one `tsconfig`, one
source directory, one alias scope. That covers **per-package refactors** in
any monorepo flavor (pnpm / npm / yarn workspaces, Nx, Turborepo, Lerna) —
just point `--cwd` at the package you're restructuring:

```bash
cd packages/web
npx front-renamer ops.json --cwd . --tsconfig tsconfig.json --src src --apply
```

`git mv` still works for files anywhere in the repo, so history stays intact
across the whole monorepo.

**What's not supported yet**: cross-package moves (sliding a file from
`packages/a` into `packages/b` while also rewriting `@org/b`-style workspace
imports), simultaneous multi-package refactors, and renaming a workspace
package itself (the `name` in its `package.json` plus every `dependencies`
reference). These need a bigger workspace-aware mode — coming when there's
real demand.

## Safety

- **Run from a clean git working tree.** Two reasons:
  1. **Auto-rollback** snapshots `HEAD` before applying and restores on
     post-typecheck failure (`git reset --hard <sha> && git clean -fd`).
     This is the safety net. It only engages when the tree was clean at
     start — otherwise the rollback would also wipe your unrelated edits.
     Disable with `--no-rollback`.
  2. **Manual rollback**. If you somehow disabled auto-rollback or didn't
     trust it, `git restore . && git clean -fd` still works the same way.
- **Pre-typecheck**: refuses to run if your project already has TS errors
  (so post-typecheck failures are clearly attributable to the refactor).
- **Dry-run by default**: nothing touches disk until you pass `--apply`.
- **Post-typecheck**: full TS pass after commit. On failure, auto-rollback
  if armed; otherwise non-zero exit with changes preserved for inspection.
- **`git mv`**: real moves, not delete+add. `git log --follow` survives.
- **Empty dirs cleaned up** after moves (deep recursive, with `--no-prune`
  to disable).

> **Run Prettier / ESLint after `--apply`.** The tool emits import specifiers
> with double quotes (`"./x"`) regardless of your project's style. It also
> doesn't reformat the surrounding code after rewrites. A single `prettier
> --write` (or your usual `pnpm run format`) puts everything back in shape.

## Programmatic use

```ts
import {loadProject, normalizeOps, buildPlan, Engine} from 'front-renamer';

const project = loadProject(process.cwd());
const ops = normalizeOps(
    [
        ['src/components/Foo', 'src/features/foo/Foo'],
    ],
    project.root,
);
const plan = buildPlan(ops);
const engine = new Engine(project);
engine.applyToVFS(plan.levels);
engine.rewriteAllImports();
engine.commit();
```

## License

MIT.
