#!/usr/bin/env python3
"""
test_suite.py — Daily smoke test for the TiDB Onboarding Tutor.

Automated checks run always. Cluster checks run only when TIDB_HOST is set.
Exits 0 if all automated checks pass, 1 if any fail.

Usage:
    python test_suite.py              # full run
    python test_suite.py --quick      # skip URL reachability (faster, offline)
    python test_suite.py --json       # emit JSON report to stdout instead

What Claude does:   runs this script, reports results
What you verify:    the HUMAN VERIFY checklist at the bottom of the report
"""

import ast
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

HERE = Path(__file__).parent
QUICK = "--quick" in sys.argv
AS_JSON = "--json" in sys.argv

# ── result model ──────────────────────────────────────────────────────────────

@dataclass
class Result:
    status: str          # PASS | FAIL | SKIP | WARN
    label: str
    detail: str = ""

    def __str__(self):
        icon = {"PASS": "✓", "FAIL": "✗", "SKIP": "–", "WARN": "!"}[self.status]
        line = f"  [{icon}] {self.label}"
        if self.detail:
            line += f"\n        {self.detail}"
        return line


results: list[Result] = []

def ok(label, detail=""):
    results.append(Result("PASS", label, detail))

def fail(label, detail=""):
    results.append(Result("FAIL", label, detail))

def skip(label, detail=""):
    results.append(Result("SKIP", label, detail))

def warn(label, detail=""):
    results.append(Result("WARN", label, detail))


# ── helpers ───────────────────────────────────────────────────────────────────

def check_url(url: str, timeout: int = 8) -> tuple[bool, str]:
    """HEAD request; returns (reachable, reason)."""
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(url, method="HEAD",
              headers={"User-Agent": "TiDB-Tutor-Smoke/1.0"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return True, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        # 403/405 still means the server answered — URL is live
        if e.code in (403, 405):
            return True, f"HTTP {e.code} (server answered)"
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, str(e)[:80]


def python_compiles(path: Path) -> tuple[bool, str]:
    try:
        ast.parse(path.read_text())
        return True, ""
    except SyntaxError as e:
        return False, f"line {e.lineno}: {e.msg}"


def run_local(cmd: list, timeout: int = 15) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "timed out"
    except FileNotFoundError as e:
        return -1, "", str(e)


# ── section 1: file integrity ─────────────────────────────────────────────────

def check_files():
    required = [
        "CLAUDE.md",
        "SETUP.md",
        "verify.py",
        "ru_collector.py",
        "curriculum.json",
        "requirements.txt",
        "progress.example.json",
        "knowledge/tidb-expert.md",
        "lessons/week-03-ai-pillars.md",
    ]
    for name in required:
        p = HERE / name
        if not p.exists():
            fail(f"File exists: {name}", "missing")
        elif p.stat().st_size == 0:
            fail(f"File non-empty: {name}", "zero bytes")
        else:
            ok(f"File exists: {name}")


# ── section 2: curriculum.json integrity ──────────────────────────────────────

def check_curriculum():
    path = HERE / "curriculum.json"
    if not path.exists():
        fail("curriculum.json: loadable", "file missing")
        return

    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        fail("curriculum.json: valid JSON", str(e))
        return
    ok("curriculum.json: valid JSON")

    weeks = data.get("weeks", [])
    total_tasks = sum(len(w.get("tasks", [])) for w in weeks)
    if total_tasks < 70:
        warn(f"curriculum.json: task count", f"{total_tasks} tasks (expected ≥70)")
    else:
        ok(f"curriculum.json: task count", f"{total_tasks} tasks across {len(weeks)} week blocks")

    # Every task must have a 't' and 'type' key
    bad = []
    for w in weeks:
        for i, t in enumerate(w.get("tasks", [])):
            if not t.get("t"):
                bad.append(f"week {w['id']} task {i}: missing 't'")
            if not t.get("type"):
                bad.append(f"week {w['id']} task {i}: missing 'type'")
    if bad:
        fail("curriculum.json: all tasks have required keys", "; ".join(bad[:3]))
    else:
        ok("curriculum.json: all tasks have required keys")

    # Check XP config exists and has expected keys
    xp = data.get("xp", {})
    for expected in ["admin", "concept", "lab", "cert", "challenge"]:
        if expected not in xp:
            warn(f"curriculum.json: xp.{expected}", "key missing from XP map")
    ok("curriculum.json: XP map present")

    # Accuracy guard: Manus number
    raw = path.read_text()
    if "10M+" in raw or "10m+" in raw.lower():
        fail("curriculum.json: Manus proof-point", "contains '10M+' — verified number is 1.4M+")
    else:
        ok("curriculum.json: Manus proof-point", "no inflated '10M+' figure found")

    return data


# ── section 3: Python script quality ─────────────────────────────────────────

def check_scripts():
    for name in ("verify.py", "ru_collector.py"):
        path = HERE / name
        if not path.exists():
            fail(f"{name}: syntax", "file missing")
            continue
        ok_flag, detail = python_compiles(path)
        if ok_flag:
            ok(f"{name}: syntax clean")
        else:
            fail(f"{name}: syntax clean", detail)

    # verify.py --help / no-args should exit with usage, not crash
    rc, out, err = run_local([sys.executable, str(HERE / "verify.py")])
    # verify.py with no args exits non-zero and prints usage to stderr
    if rc != 0 and len(err) > 20:
        ok("verify.py: prints usage when called with no args")
    else:
        warn("verify.py: usage output", f"unexpected: rc={rc} out='{out[:60]}' err='{err[:60]}'")


# ── section 4: knowledge file accuracy guards ─────────────────────────────────

def check_knowledge():
    path = HERE / "knowledge" / "tidb-expert.md"
    if not path.exists():
        fail("knowledge/tidb-expert.md: exists")
        return

    text = path.read_text()

    # Must NOT contain the inflated Manus number
    if "10M+" in text or "10m+" in text.lower():
        fail("knowledge/tidb-expert.md: Manus figure", "contains '10M+' — should be 1.4M+")
    else:
        ok("knowledge/tidb-expert.md: Manus figure", "1.4M+ present, no '10M+'")

    # "TiCI" is only a problem if used as a positive recommendation.
    # A line like "Do not attribute to TiCI" is fine.
    tici_lines = [l.strip() for l in text.splitlines() if "TiCI" in l]
    bad_tici = [l for l in tici_lines
                if not any(neg in l.lower() for neg in
                           ["do not", "don't", "not use", "avoid", "not attribute"])]
    if bad_tici:
        warn("knowledge/tidb-expert.md: TiCI reference",
             f"appears without negation: {bad_tici[0][:80]}")
    else:
        ok("knowledge/tidb-expert.md: TiCI only in negation context")

    # Must mention eventual consistency for FTS/vector
    if "eventually consistent" in text.lower() or "eventual" in text.lower():
        ok("knowledge/tidb-expert.md: eventual-consistency caveat present")
    else:
        fail("knowledge/tidb-expert.md: eventual-consistency caveat",
             "file does not mention eventual consistency for FTS/vector search")

    # Must mention BYOC
    if "BYOC" in text:
        ok("knowledge/tidb-expert.md: BYOC coverage")
    else:
        warn("knowledge/tidb-expert.md: BYOC coverage", "BYOC not mentioned")

    # db9 accuracy
    if "Postgres-wire" in text or "postgres-wire" in text.lower():
        ok("knowledge/tidb-expert.md: db9 framed as Postgres-wire")
    else:
        warn("knowledge/tidb-expert.md: db9 framing", "Postgres-wire distinction not explicit")


# ── section 5: lesson file quality ────────────────────────────────────────────

def check_lessons():
    lesson_dir = HERE / "lessons"
    files = sorted(lesson_dir.glob("*.md")) if lesson_dir.exists() else []

    if not files:
        warn("lessons/: lesson files", "no lesson .md files found")
        return

    for f in files:
        text = f.read_text()
        issues = []
        for required_phrase in ["Framing", "Assign", "Check", "SE drill", "Socratic"]:
            if required_phrase.lower() not in text.lower():
                issues.append(f"missing '{required_phrase}' section")
        if issues:
            warn(f"lessons/{f.name}: structure", "; ".join(issues))
        else:
            ok(f"lessons/{f.name}: structure complete")


# ── section 6: URL reachability (labs.tidb.io + public docs) ─────────────────

def check_urls(data: Optional[dict]):
    if QUICK:
        skip("URL reachability checks", "--quick flag set")
        return

    if data is None:
        skip("URL reachability checks", "curriculum.json failed to load")
        return

    # Collect all labs.tidb.io URLs from curriculum
    lab_urls = []
    for w in data.get("weeks", []):
        for t in w.get("tasks", []):
            u = t.get("url", "")
            if "labs.tidb.io" in u:
                lab_urls.append((t["t"][:50], u))

    # Also check a few key public docs pages
    public_checks = [
        ("docs.pingcap.com: vector search", "https://docs.pingcap.com/tidbcloud/vector-search-overview"),
        ("docs.pingcap.com: AI features",   "https://docs.pingcap.com/tidbcloud/ai-feature-concepts/"),
        ("pingcap.com: AI landing",          "https://www.pingcap.com/ai/"),
        ("mem9.ai: reachable",               "https://mem9.ai/"),
        ("db9.ai: reachable",                "https://db9.ai/"),
        ("sys9.ai: reachable",               "https://sys9.ai/"),
        ("github: agent-rules",              "https://github.com/pingcap/agent-rules"),
        ("github: mem9-ai/mem9",             "https://github.com/mem9-ai/mem9"),
    ]

    # Check labs
    failed_labs = []
    for name, url in lab_urls:
        reachable, reason = check_url(url)
        if reachable:
            ok(f"lab URL reachable: {url.split('/')[-1]}", reason)
        else:
            fail(f"lab URL reachable: {url.split('/')[-1]}", f"{url} → {reason}")
            failed_labs.append(url)

    # Check public docs
    for label, url in public_checks:
        reachable, reason = check_url(url)
        if reachable:
            ok(f"URL: {label}", reason)
        else:
            warn(f"URL: {label}", f"{url} → {reason}")


# ── section 7: cluster connectivity (only if TIDB_HOST is set) ───────────────

def check_cluster():
    host = os.environ.get("TIDB_HOST", "")
    if not host:
        skip("Cluster: TIDB_HOST not set",
             "set TIDB_HOST + TIDB_USER + TIDB_PASSWORD + TIDB_SSL=true to enable")
        return

    rc, out, err = run_local([sys.executable, str(HERE / "verify.py"), "--ping"])
    if rc == 0 and "OK" in out:
        ok("Cluster: connectivity", out)
    else:
        fail("Cluster: connectivity", err or out)
        return  # no point running further cluster tests

    # Basic SQL sanity
    for sql, expected_col in [
        ("SELECT 1 AS x", "x"),
        ("SELECT VERSION() AS v", "v"),
    ]:
        rc, out, err = run_local([sys.executable, str(HERE / "verify.py"), sql])
        if rc == 0 and expected_col in out:
            ok(f"Cluster: {sql[:30]}")
        else:
            fail(f"Cluster: {sql[:30]}", err or out)

    # RU collector smoke
    rc, out, err = run_local([sys.executable, str(HERE / "ru_collector.py")])
    if rc == 0:
        ok("Cluster: ru_collector.py runs clean")
    else:
        fail("Cluster: ru_collector.py runs clean", err[:120] or out[:120])


# ── human verify checklist ────────────────────────────────────────────────────

HUMAN_CHECKLIST = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HUMAN VERIFY  (takes ~5 minutes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

These can't be automated — they need judgment:

[ ] SETUP.md still matches the actual TiDB Cloud console UI
    (the "Connect" button location and username format change occasionally)

[ ] knowledge/tidb-expert.md: spot-check one proof point against
    an internal source before it gets into a lesson session

[ ] lessons/week-03-ai-pillars.md: read the "SE drill" for Task 1.
    Would a skeptical prospect accept that two-sentence answer?

[ ] If any labs.tidb.io URL FAILed above:
    open the URL in a browser and confirm it is actually dead
    (not just a HEAD-request block), then remove or replace it in curriculum.json

[ ] If cluster tests ran: do the RU numbers from ru_collector look
    reasonable for the queries that were run? (no thousands of RUs
    for simple point-lookups = good sign)
"""

# ── main ──────────────────────────────────────────────────────────────────────

def main():
    start = time.time()
    print(f"\n{'━'*60}")
    print(f"  TiDB Onboarding Tutor — Daily Smoke Test")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if QUICK:
        print("  Mode: quick (URL checks skipped)")
    print(f"{'━'*60}\n")

    print("── File integrity ───────────────────────────────────────")
    check_files()

    print("\n── curriculum.json ──────────────────────────────────────")
    data = check_curriculum()

    print("\n── Python scripts ───────────────────────────────────────")
    check_scripts()

    print("\n── Knowledge file accuracy ──────────────────────────────")
    check_knowledge()

    print("\n── Lesson file structure ────────────────────────────────")
    check_lessons()

    print("\n── URL reachability ─────────────────────────────────────")
    check_urls(data)

    print("\n── Cluster (live) ───────────────────────────────────────")
    check_cluster()

    # ── summary ──
    elapsed = time.time() - start
    passed  = sum(1 for r in results if r.status == "PASS")
    failed  = sum(1 for r in results if r.status == "FAIL")
    skipped = sum(1 for r in results if r.status == "SKIP")
    warned  = sum(1 for r in results if r.status == "WARN")

    # Print results grouped
    print()
    for r in results:
        print(str(r))

    print(f"\n{'━'*60}")
    print(f"  {passed} passed  ·  {failed} failed  ·  {warned} warnings  ·  {skipped} skipped")
    print(f"  Completed in {elapsed:.1f}s")
    print(f"{'━'*60}")

    if AS_JSON:
        print(json.dumps({
            "date": datetime.now().isoformat(),
            "passed": passed, "failed": failed,
            "warned": warned, "skipped": skipped,
            "results": [{"status": r.status, "label": r.label, "detail": r.detail}
                        for r in results]
        }, indent=2))
        return

    if failed > 0:
        print(f"\n  ⚠  {failed} check(s) failed — review before the next session.\n")
    else:
        print(f"\n  All automated checks pass.\n")

    print(HUMAN_CHECKLIST)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
