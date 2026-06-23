# TiDB Onboarding Tutor (Claude Code)

An interactive onboarding tutor for new Solutions Engineers. You open this folder in **Claude
Code**, and Claude becomes a tutor that walks you through the SE ramp against your own **TiDB
Cloud** cluster: it teaches a concept in SE language, makes you build it yourself, checks your
work on the live cluster, then drills you on how to explain it to a customer.

It is not a video and it is not a checklist. It is a conversation with a partner that can run
SQL and hold you to getting it right.

## Why this exists

Passive video courses teach recognition, not recall, and they cannot tell whether you actually
understood. This tutor makes you do the thing, verifies it against a real cluster, and pressure
-tests the explanation, because that is the job: standing in front of distributed-systems
engineers and being right.

## Setup

1. Create a free [TiDB Cloud Starter](https://tidbcloud.com) cluster (serverless, scales to
   zero, free).
2. Install the connector: `pip install -r requirements.txt`
3. Export your connection:
   ```bash
   export TIDB_HOST=<host> TIDB_PORT=4000 TIDB_USER=<user> \
          TIDB_PASSWORD=<pass> TIDB_DB=onboarding TIDB_SSL=true
   ```
4. Open this folder in Claude Code and say: **"Start my onboarding."**

Claude reads `CLAUDE.md` (its operating manual), `curriculum.json` (the schedule), and the
matching `lessons/week-NN-*.md`, checks your cluster with `verify.py --ping`, and begins.

## What's here

| File | Role |
|------|------|
| `CLAUDE.md` | The tutor's operating manual: how to run a session, how to verify, accuracy rules. |
| `curriculum.json` | The re-sequenced SE schedule (shared with the rest of onboarding). |
| `lessons/week-03-ai-pillars.md` | A complete example lesson (vector, full-text, hybrid search). |
| `verify.py` | Runs SQL against your cluster so the tutor checks your work instead of doing it. |
| `progress.example.json` | The shape of the per-trainee progress file. |

Currently one lesson (Week 3) is written out as the reference format. The remaining weeks are
defined in `curriculum.json`; the tutor can teach them from the curriculum and docs today, and
we will flesh out a lesson file per week in that same format.

## Optional: persist progress in mem9 (agent-native onboarding)

Instead of a local `progress.json`, point the tutor at the **mem9** plugin so your onboarding
progress and what you struggled with live as cognitive memory on TiDB Cloud Zero. The onboarding
tool then *is* an agent-memory-on-TiDB demo, which is exactly what you will be selling. See the
[Mem9 AI Coding](https://github.com/stephenlthorn/mem9-ai-coding) demo for the pattern.

## Accuracy notes

Vector + full-text search run on TiFlash (Raft Learner replica, eventually consistent on the
search path), not a separate "TiCI" component. db9 is positioned as serverless Postgres, not
TiDB's MySQL-wire engine. Verify proof-point numbers before quoting them.
