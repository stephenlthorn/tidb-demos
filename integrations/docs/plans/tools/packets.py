import glob
import re
import sys

LIVE = re.compile(
    r"tiup playground|docker compose|docker run|terraform (apply|plan|destroy)|aws |kubectl|curl |"
    r"Okta|okta\.com|Databricks workspace|chalk (login|apply|query)|Datadog|pnpm lab run|--record|"
    r"Windows|BlackHole|microphone|AssemblyAI|ANTHROPIC_API_KEY|psql |mysql -h",
)
CLOUD = re.compile(r"terraform (apply|destroy)|aws dms|aws rds|Aurora|EKS|TiDB Cloud|Databricks|Datadog|Chalk|Okta|Windows")
AUDIO = re.compile(r"BlackHole|microphone|system audio|sox ")


def section(text, number):
    match = re.search(rf"^## {number}\..*?$(.*?)(?=^## \d+\.|\Z)", text, re.S | re.M)
    return match.group(1) if match else ""


def split_tasks(body):
    pattern = re.compile(r"^(?:### Task (?:\d+\.)?(\d+)[:.\s-]*(.*)|- \[ \] \*\*Task (\d+) - (.*?)\*\*.*)$", re.M)
    marks = list(pattern.finditer(body))
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(body)
        number = mark.group(1) or mark.group(3)
        title = (mark.group(2) or mark.group(4) or "").strip().strip("*").strip()
        yield int(number), title, body[mark.start():end]


def merge_red_green(tasks):
    merged = []
    pending = None
    for number, title, chunk in tasks:
        if pending is not None:
            merged.append((pending[0], f"{pending[0]}-{number}", title.replace("GREEN:", "").strip(), pending[2] + chunk))
            pending = None
            continue
        if title.startswith("RED:"):
            pending = (number, title, chunk)
            continue
        merged.append((number, str(number), title, chunk))
    if pending is not None:
        merged.append((pending[0], str(pending[0]), pending[1], pending[2]))
    return merged


def owned_files(chunk, demo):
    found = sorted(set(re.findall(rf"demos/{demo}/[\w./-]+[\w]", chunk)))
    real = [f for f in found if not re.search(r"(^|/)\.env$|/\.venv/|/node_modules/", f)]
    return [f for f in real if not any(other.startswith(f + "/") for other in real)]


def category_gates(files, demo):
    lines = []
    docs = [f for f in files if f.endswith(".md")]
    if docs:
        lines.append("  - `grep -c $'\\u2014' " + " ".join(f"integrations/{d}" for d in docs) + "` -> 0 for every file")
        lines.append("  - `pnpm lab check-public` -> `0 findings`")
    if any(f.endswith(".env.example") for f in files):
        lines.append(f"  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/{demo}/.env.example` -> 8")
    composes = [f for f in files if re.search(r"(docker-)?compose\.ya?ml$", f)]
    lines += [f"  - `docker compose -f integrations/{c} config -q` -> exit 0" for c in composes]
    tf_dirs = sorted({f.rsplit("/", 1)[0] for f in files if f.endswith(".tf")})
    lines += [f"  - `terraform -chdir=integrations/{d} init -backend=false && terraform -chdir=integrations/{d} validate` -> `Success! The configuration is valid.`" for d in tf_dirs]
    pys = [f for f in files if f.endswith(".py")]
    if pys:
        lines.append(f"  - `cd integrations/demos/{demo} && .venv/bin/python -m py_compile " + " ".join(p.replace(f"demos/{demo}/", "") for p in pys) + "` -> exit 0")
    return lines


def gate(chunk, demo):
    one_line = re.findall(
        r"(?:Run|Manual live-run|Manual step|Live check|Verify)[^`\n]*?`([^`]+)`[^\n]*?[Ee]xpected(?: output)?[:\s-]*([^\n]+)",
        chunk,
    )
    two_line = re.findall(r"Run:?\s*`([^`]+)`[^\n]*\n\s*Expected\s*:?\s*([^\n]+)", chunk)
    pairs = [(c.strip(), e.strip().rstrip('.')) for c, e in one_line + two_line]
    seen = []
    for cmd, expected in pairs:
        if "FAIL" in expected.split(" ")[0:3] or expected.upper().startswith("FAIL"):
            continue
        if cmd not in [c for c, _ in seen]:
            seen.append((cmd, expected))
    lines = [f"  - `{cmd}` -> {expected}" for cmd, expected in seen[-3:]]
    if re.search(rf"demos/{demo}/[\w./-]+\.ts\b", chunk):
        lines.append(f"  - `pnpm --filter @lab/demo-{demo} typecheck` -> exit 0")
    return lines


def runtime(chunk):
    if AUDIO.search(chunk):
        return "audio (coordinator only, user present for consent)"
    if CLOUD.search(chunk) and LIVE.search(chunk):
        return "cloud-account"
    if re.search(r"kafka|Kafka Connect|9092", chunk) and LIVE.search(chunk):
        return "tidb-playground + kafka"
    if LIVE.search(chunk):
        return "tidb-playground"
    return "none"


def effort(chunk):
    lines = chunk.count("\n")
    return "S" if lines < 80 else "M" if lines < 200 else "L"


def build(path):
    text = open(path).read()
    demo = re.search(r'"id":\s*"([a-z0-9-]+)"', text).group(1)
    number = path.split("-")[0]
    verify_rows = [line.strip() for line in section(text, 4).splitlines() if "UNVERIFIED" in line]
    tasks = merge_red_green(list(split_tasks(section(text, 7))))
    out = [
        "",
        "## 10. Subagent work packets",
        "",
        "Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.",
        "",
    ]
    verify_id = f"{number}-V1"
    if verify_rows:
        out += [
            f"### Packet {verify_id}: Verify open facts before building",
            "- Tasks: none (docs only)",
            "- Depends on: 00-P10   Shared runtime: " + ("cloud-account" if CLOUD.search(" ".join(verify_rows)) else "tidb-playground"),
            f"- Files owned: `integrations/docs/plans/{path}` (section 4 only)",
            "- Model: sonnet   Effort: S",
            "- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):",
            *[f"  - {row[:300]}" for row in verify_rows],
            "- Gate:",
            f"  - `grep -c UNVERIFIED integrations/docs/plans/{path}` -> lower than before, and every remaining item says why it cannot be checked yet",
            "- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.",
            "",
        ]
    previous = verify_id if verify_rows else "00-P10"
    for task_number, task_label, title, chunk in tasks:
        packet_id = f"{number}-P{task_number}"
        files = owned_files(chunk, demo)
        tests = [f for f in files if re.search(r"(\.test\.tsx?|/test_[\w]+\.py)$", f)]
        shared = runtime(chunk)
        gate_lines = gate(chunk, demo)
        if not gate_lines and tests:
            gate_lines = [f"  - `pnpm --filter @lab/demo-{demo} exec vitest run {' '.join(t.replace(f'demos/{demo}/', '') for t in tests)}` -> all PASS"]
        gate_lines = gate_lines + [line for line in category_gates(files, demo) if line not in gate_lines]
        if not gate_lines:
            gate_lines = [f"  - every command in Task {task_label} produces the output the task quotes; the coordinator pastes that output into the packet report"]
        if shared.startswith("cloud"):
            gate_lines.append("  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts")
        model = "coordinator" if shared.startswith("audio") or not files else "sonnet"
        out += [
            f"### Packet {packet_id}: {title or 'Task ' + str(task_number)}",
            f"- Tasks: {task_label}",
            f"- Depends on: {previous}   Shared runtime: {shared}",
            "- Files owned: " + (", ".join(f"`integrations/{f}`" for f in files) if files else "none (manual or docs step)"),
            f"- Model: {model}   Effort: {effort(chunk)}",
            "- Gate:",
            *gate_lines,
            f"- Done when: Task {task_label}'s steps are all checked off and the gate output matches.",
            "",
        ]
        previous = packet_id
    out += [
        f"### Packet {number}-R: Record and publish the featured trace",
        "- Tasks: section 8",
        f"- Depends on: {previous}   Shared runtime: " + ("cloud-account" if CLOUD.search(section(text, 5)) else "tidb-playground"),
        f"- Files owned: `integrations/demos/{demo}/traces/featured.json`",
        "- Model: coordinator   Effort: M",
        "- Gate:",
        f"  - `pnpm lab validate {demo}` -> `{demo}: manifest ok, featured trace ok (N events)`",
        "  - `pnpm lab check-public` -> `0 findings`",
        "  - teardown commands from section 5 run and confirmed",
        "- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.",
        "",
    ]
    text = re.sub(r"\n## 10\. Subagent work packets.*\Z", "", text, flags=re.S)
    open(path, "w").write(text.rstrip("\n") + "\n" + "\n".join(out))
    return demo, len(tasks), bool(verify_rows)


for plan in sys.argv[1:]:
    print(plan, build(plan))
