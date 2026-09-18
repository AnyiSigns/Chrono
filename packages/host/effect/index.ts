// 效果包出口：单轮效果执行（含审计）、通用 run loop、A1 路由与 A10 轮间驱动。

export { executeEffect } from './execute.ts'
export type { EndpointCaller, ExecuteOutcome } from './execute.ts'
export { activeGenOf, createRoundRouter } from './route.ts'
export type { RouteError, RouteOutcome, RoundRouter, RouterOptions } from './route.ts'
export { DEFAULT_CALL_TIMEOUT_MS, runRound } from './run-loop.ts'
export type { RoundInput, RoundOutcome } from './run-loop.ts'
export { runSubmission } from './rounds.ts'
export type { SubmissionInput, SubmissionOutcome } from './rounds.ts'
