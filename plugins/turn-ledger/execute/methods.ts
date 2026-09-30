// ??? `turn-ledger` ??????`settle`???? trace ?? + ?????trace ? verdict ????????
// ? `decide`?????????????? loop-policy body / ???? verdict??
// ??????????? args ?????????????? / ???? / ????? port.call ?????
// ???trace ? verdict ??????proposal ??????????? `loop-policy` body?

import { baseSeqOf, isRecord, asString } from './plan.ts'
import { RoundPatches, type RoundBase } from './plan.ts'
import {
  evolutionBody,
  expandAdoption,
  expandRejection,
  ledgerEntries,
  scanProposals,
} from './proposals.ts'
import { buildTraceTail, type TraceFacts } from './tail.ts'
import { PINS } from './plugin.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, GraphModel, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

export interface TurnLedgerDeps {
  port: PortCaller
  pins?: Rec
}

function asRecord(value: Json | undefined): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}

/** ??????evolution ??? body + ?????????trace ? verdict ????????? */
function newRound(bag: Rec): RoundPatches {
  const base: RoundBase = {
    body: evolutionBody(bag),
    base: baseSeqOf(bag['evolution']),
  }
  return new RoundPatches(new Map<string, RoundBase>([['evolution', base]]))
}

/** `settle(args)`??? trace ???+ ????????????? batch ?????????? */
async function settle(args: Json, env: CallEnv, deps: TurnLedgerDeps): Promise<Json> {
  const input = asRecord(args)
  if (input === null) throw new BadArgsError('args must be an object')
  const bag = asRecord(input['bag'])
  const model = asRecord(input['model'])
  const trace = asRecord(input['trace'])
  if (bag === null) throw new BadArgsError('args.bag must be an object')
  if (model === null) throw new BadArgsError('args.model must be an object')
  if (trace === null) throw new BadArgsError('args.trace must be an object')
  const pins = asRecord(input['pins']) ?? deps.pins ?? PINS
  const directives = Array.isArray(input['directives']) ? (input['directives'] as Json[]) : []
  const graphHash = asString(input['graph_hash'])
  const at = asString(input['at']) ?? new Date(env.now).toISOString()
  const round = newRound(bag)

  buildTraceTail(bag, trace as unknown as TraceFacts, directives, env, graphHash, at, round)

  const extra: Json[] = []
  const events: Json[] = []
  let pending: Rec | null = null
  if (input['scan'] === true) {
    const scan = await scanProposals({
      bag,
      env,
      model: model as unknown as GraphModel,
      pins,
      port: deps.port,
      run: env.run,
      workspaceId: asString(bag['workspace_id']),
      at,
      round,
    })
    for (const directive of scan.directives) extra.push(directive)
    for (const event of scan.events) events.push(event as unknown as Json)
    pending = scan.pending
  }
  return { extra, batch: round.finalize(), pending, events }
}

/** ???????? / ?? payload ? accept / deny?????? approved / denied?? */
function resumeVerdict(resume: Rec | null): string | null {
  if (resume === null) return null
  const payload = isRecord(resume['payload']) ? (resume['payload'] as Rec) : resume
  const raw = asString(payload['verdict']) ?? asString(payload['decision'])
  if (raw === 'accept') return 'approved'
  if (raw === 'deny') return 'denied'
  return raw
}

function stringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** `decide(args)`???????????? ? ? patch.writes[] ??????? ? ???? verdict? */
function decide(args: Json, env: CallEnv, deps: TurnLedgerDeps): Json {
  const input = asRecord(args)
  if (input === null) throw new BadArgsError('args must be an object')
  const bag = asRecord(input['bag'])
  if (bag === null) throw new BadArgsError('args.bag must be an object')
  const resume = asRecord(input['resume'])
  if (resume === null) throw new BadArgsError('args.resume must be an object')
  const pins = asRecord(input['pins']) ?? deps.pins ?? PINS
  const at = asString(input['at']) ?? new Date(env.now).toISOString()
  const cursor = isRecord(resume['cursor']) ? (resume['cursor'] as Rec) : {}
  const proposalIds = stringList(cursor['proposal_ids'])
  const proposals = ledgerEntries(bag, 'proposals')
  const verdict = resumeVerdict(resume)
  const round = newRound(bag)
  if (verdict === 'approved' || verdict === 'accept') {
    for (const id of proposalIds) {
      const proposal = proposals.find((item) => item['id'] === id)
      if (proposal !== undefined) expandAdoption(bag, proposal, pins, at, env.run, round)
    }
    return {
      batch: round.finalize(),
      summary: { ok: true, kind: 'adopt', proposal_ids: proposalIds },
    }
  }
  expandRejection(bag, proposalIds, at, env.run, 'human_denied', round)
  return { batch: round.finalize(), summary: { ok: true, kind: 'reject', proposal_ids: proposalIds } }
}

/** ?????????????????? main ???? */
export function createHandlers(deps: TurnLedgerDeps): Record<string, Handler> {
  return {
    settle: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: await settle(args, env, deps),
      events: [],
    }),
    decide: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: decide(args, env, deps),
      events: [],
    }),
  }
}
