// 端到端测试框架入口：闭包计算 / 临时根世界 / 模型桩 / 记录器 / 场景装配。
export { REPO_ROOT, PLUGINS_DIR, FIXTURE_PLUGINS_DIR, TOY_OVERRIDES, NATIVE_CARGO_IDENTITIES, computeClosure, computeNeedsTargets, computeWorldIdentities, cargoIdentities, readPinGraph, readDecl, providerIndex, sourceDirFor, toyFor, fixturePluginDir } from './closure.mjs'
export { bootWorld, NativeTokenizerMissing } from './world.mjs'
export { startModelStub } from './model-stub.mjs'
export { createRecorder, lastEvalValue, historyMessages, externPayloads, toolParts, toolCallResponder } from './recorder.mjs'
export { bootScenario, configureModel } from './scenario.mjs'
export { seedIdentityBody, loopPolicyBudgetBody } from './seed-body.mjs'
export { foldDisplayOutcome } from './display-outcome.mjs'
