/**
 * Library entry-point. Re-exports the public surface so consumers can drive the
 * tool programmatically (e.g. from a custom CLI, a build script, or a test).
 */
export type {
    RefactorOp,
    RefactorOpInput,
    RefactorOpShort,
    RefactorOpFull,
    NormalizedOp,
    OpsInput,
    PlanLevel,
} from './schema.js';

export {loadProject, normalizeOps, validateOps} from './preflight.js';
export type {ProjectInfo, LoadProjectOptions, ValidationError} from './preflight.js';

export {buildPlan, summarizePlan} from './plan.js';
export type {PlanResult} from './plan.js';

export {Engine} from './engine.js';
export {VFSTree, FsNode} from './vfs.js';
export {runTypecheck} from './typecheck.js';
export type {TypecheckResult} from './typecheck.js';
