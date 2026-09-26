# Executing the Lab Plans with Sonnet Subagents

This file turns the plans in this folder into work a coordinator (main model) hands to Sonnet subagents one packet at a time. Plans say *what* to build; this file says *how to delegate it safely*.

## Roles

- **Coordinator (main model):** picks the next packet, dispatches it, reviews the diff, runs the packet's gate commands itself, commits only when the gate passes, and pushes after every green packet. Never lets two agents touch the same files or the same shared runtime at once.
- **Builder (Sonnet subagent, one per packet):** implements exactly one packet, test-first, and reports the gate output verbatim. Does not commit, push, or edit files outside the packet's file list.
- **Reviewer (Sonnet subagent, optional per packet):** reads the diff against the plan's task text and the conformance checklist below, and reports findings. Does not edit.

## Conformance checklist (every plan and every packet must satisfy it)

1. Imports use the exact names in `00-platform.md` "Interfaces". Test fixtures come from `@lab/contract/testing` (`manifestInput`, `aManifest`), never re-declared.
2. `runner.command` is `["node", "--import", "tsx", "runner/main.ts"]` for TypeScript runners (with `tsx` as a devDependency of the demo package) and `[".venv/bin/python", "-u", "runner/main.py"]` for Python runners. Runner entry lives at `runner/main.ts` or `runner/main.py`; logic in `runner/src/`; tests in `runner/test/` or `test/`.
3. Every demo package is named `@lab/demo-<id>`, has `test` and `typecheck` scripts, depends on `@lab/contract` and `@lab/runner-kit` via `workspace:*`, and its `tsconfig.json` extends `../../tsconfig.base.json`.
4. Every manifest id, metric id, edge id, phase id, check id, control id is kebab-case; every metric has `howMeasured`; `pattern` names no customer.
5. TiDB connections only through `createTidbPool` / `tidbConfigFromEnv` (Python: `tidb_connect_from_env`); dynamic identifiers only through `quoteIdentifier`.
6. `.env.example` starts with the standard block from `00-platform.md`, then demo variables; `LAB_ENV_COMPONENT_*` records versions of every non-TiDB component.
7. Ports: TiDB 4000, PD 2379, TiCDC 8300, Prometheus 9090, Grafana 3000, relay 7070, Vite 5173, Kafka 9092 / Connect 8083, Redis 6379. A demo needing another port documents it in its README and does not reuse these.
8. No em dashes, no customer names, no internal URLs, no code comments, no `any`, no type assertions.
9. Every UNVERIFIED item has a **verify packet** that runs before any packet whose code depends on it.

## Packet format (section 10 of every demo plan)

```
### Packet NN-P<k>: <name>
- Tasks: <task numbers from section 7>
- Depends on: <packet ids>   Shared runtime: <none | tidb-playground | kafka | aws | cloud-account>
- Files owned: <exact paths; nothing else may be edited>
- Model: sonnet   Effort: <S (<1h) | M (1-3h) | L (3h+)>
- Gate (coordinator runs these, all must pass):
  - `<exact command>` -> `<expected output>`
- Done when: <one sentence>
```

Rules for packets:
- One packet = one reviewable commit's worth (usually 1-3 tasks). Pure-logic packets come before adapter packets.
- **Verify packets** (named `Verify: ...`) run the UNVERIFIED checks, paste the real output into the plan's section 4, and flip the status to VERIFIED or record the workaround. They change docs only.
- **Live packets** (anything that needs Docker, tiup playground, a cloud account, or credentials) are marked `Shared runtime` and are run by the coordinator or one agent at a time, never in parallel with another packet using the same runtime.
- Cloud packets list the teardown command in their gate, and the coordinator confirms teardown before moving on.

## Dispatch prompt template (coordinator fills the brackets)

```
You are implementing ONE work packet of the TiDB Integration Lab.
Repo: /Users/stephen/GitHub/tidb-demos, working dir integrations/.
Read: integrations/docs/plans/00-platform.md (contract), integrations/docs/plans/EXECUTION.md (checklist),
and integrations/docs/plans/[PLAN FILE] section 7 tasks [TASK NUMBERS] and section 10 packet [PACKET ID].
Implement exactly those tasks, test-first, in the order written. Edit only the packet's "Files owned".
If the plan's code fails to compile or a test expectation is wrong, fix it minimally and note the
deviation. Do not commit or push. Do not start servers, Docker, tiup, or cloud resources unless the packet
says Shared runtime and the coordinator told you to. Finish by running the packet's gate commands and
reporting their output verbatim, then list any deviations from the plan in at most 10 lines.
```

## Waves

| Wave | Packets | Parallel? |
|---|---|---|
| 1 | Plan 00 packets in order (00-P1 ... ) | Sequential; everything depends on it |
| 2 | Pure-logic packets of 02, 04, 05, 08, 12 | Yes, up to 5 agents; no shared runtime |
| 3 | Live packets of 02 then 03, 04 (share tidb-playground + kafka) | Sequential |
| 4 | Verify + adapter packets of 01, 06, 07, 10 (cloud accounts) | One cloud demo at a time |
| 5 | 09, 11 and remaining live packets | Sequential |
| 6 | Record featured traces, `pnpm build:site`, deploy | Coordinator |

After each wave: `pnpm typecheck && pnpm test && pnpm lab check-public` from `integrations/`, then push.
