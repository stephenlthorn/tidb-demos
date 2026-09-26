# Plan NN: <Integration> + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one sentence: what the audience sees and what it proves>

**Architecture:** <2-3 sentences: components, data path, where metrics come from>

**Tech Stack:** <runner language, vendor SDKs, infra tooling>

**Depends on:** Plan 00 (platform). <any other plan, e.g. Plan 02 for Kafka topics>

---

## 1. Why this demo

- **The question customers ask:** <verbatim-style question, anonymized>
- **Pattern:** <anonymized customer pattern; must match manifest.pattern>
- **What TiDB proves here:** <2-4 bullets, each one a claim the demo measures>
- **What this demo does not claim:** <honest limits>

## 2. What the audience sees

### Flow diagram

<ASCII diagram of nodes and edges, matching manifest.json exactly>

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|

## 4. Verified facts and sources

Every product capability this demo relies on, with the official doc URL checked while writing this plan. Anything not confirmed is marked **UNVERIFIED** with the exact step to confirm it before building.

| Fact | Source | Status |
|---|---|---|

## 5. Prerequisites, cost, and teardown

- Accounts and access:
- Local tools:
- Cost model: <what bills, the formula, the vendor pricing page URL; no hardcoded prices>
- Teardown: <exact commands; how to confirm nothing is left billing>

## 6. File structure

<tree of every file this plan creates, with one line on each file's responsibility>

## 7. Tasks

<bite-sized TDD tasks: failing test, run (expected FAIL), minimal code, run (expected PASS), commit. Complete code in every step. Manual live-run steps list exact commands and expected output.>

## 8. Recording the featured trace

<exact steps to run with --record, what a good run looks like, how to set LAB_ENV_*, how to promote to traces/featured.json, `pnpm lab validate <id>` and `pnpm lab check-public`>

## 9. Risks and gotchas

<known failure modes and their fixes>
