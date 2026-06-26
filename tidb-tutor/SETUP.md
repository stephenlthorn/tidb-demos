# First-Time Setup: Connecting Your TiDB Cloud Cluster

Every interactive exercise in this tutor runs against **your own** TiDB Cloud Starter cluster.
This is intentional: you are learning to sell TiDB by using TiDB. The cluster is free, scales
to zero when idle, and takes about three minutes to set up.

Follow these steps exactly once. After this you just set the env vars and go.

---

## Step 1: Create your cluster

1. Go to **https://tidbcloud.com** and sign in with your PingCAP SSO.
2. Click **Create Cluster**.
3. Select **Serverless** (the free tier). Leave the defaults - us-east-1 is fine.
4. Name it something like `se-onboarding`. Click **Create**.

The cluster is ready in about 30 seconds.

---

## Step 2: Get your connection string

1. In the TiDB Cloud console, click your cluster name.
2. Click **Connect** in the top right.
3. Select **General** as the connection type.
4. Choose **MySQL CLI** or **Python** from the dropdown - both show the same values.

You need four values:
- **Host** - looks like `gateway01.us-east-1.prod.aws.tidbcloud.com`
- **Port** - always `4000` for TiDB Cloud
- **User** - looks like `xxxxxxxx.root` (has a prefix, **not** just `root`)
- **Password** - you will be asked to generate one if you haven't already; click "Generate"

**Copy the password immediately.** TiDB Cloud only shows it once.

---

## Step 3: Set your environment variables

Open the terminal you'll use for Claude Code sessions and export these:

```bash
export TIDB_HOST="<your host from Step 2>"
export TIDB_PORT="4000"
export TIDB_USER="<your user from Step 2, including the prefix>"
export TIDB_PASSWORD="<your password from Step 2>"
export TIDB_DB="onboarding"
export TIDB_SSL="true"
```

**TIDB_SSL=true is mandatory** for TiDB Cloud Starter. Without it the connection either
fails or hangs.

To avoid re-exporting every session, add these to your shell profile (`~/.zshrc` or
`~/.bash_profile`). Keep the file private - your password is in it.

---

## Step 4: Install the connector

```bash
cd tidb-tutor
pip install -r requirements.txt
```

This installs `pymysql`, which is the only dependency.

---

## Step 5: Verify connectivity

```bash
python verify.py --ping
```

Expected output:
```
OK  version=8.x.x  time=2026-xx-xx xx:xx:xx
```

If you see `PING FAILED`, the three most common causes are:

| Symptom | Fix |
|---------|-----|
| `Name or service not known` | TIDB_HOST is wrong or not exported in this shell |
| `Access denied for user` | TIDB_USER must include the prefix (e.g. `abc123.root`, not `root`) |
| `SSL connection error` | Make sure TIDB_SSL=true is set |
| Connection hangs | Missing TIDB_SSL=true - TiDB Cloud requires TLS |

If none of those fix it, paste the exact error to the tutor and it will help you diagnose.

---

## Step 6: Create the training database

```bash
python verify.py "CREATE DATABASE IF NOT EXISTS onboarding"
python verify.py "USE onboarding; SELECT DATABASE()"
```

Expected: one row showing `onboarding`.

---

## What the tutor does with this connection

During **custom exercises** (tasks the tutor assigns inline, not labs.tidb.io links), the
tutor runs `verify.py` to check your actual SQL output against the expected result. It will:

- Confirm your table exists and has the right shape
- Run your query and report actual row counts, scores, and plans back to you
- Run `EXPLAIN ANALYZE` when diagnosing slow or wrong queries
- Run `ru_collector.py` to show you what your exercises cost in RUs

**labs.tidb.io labs** are fully self-contained and do not need this connection. They provide
their own cluster environment. Just click the URL and follow the lab instructions.

---

## Quick reference

```bash
# Connectivity check
python verify.py --ping

# Run any read query
python verify.py "SELECT COUNT(*) FROM docs"

# Run from a file
python verify.py -f checks/my_check.sql

# Check RU consumption of recent queries
python ru_collector.py

# Check RU cost of a specific query
python ru_collector.py "SELECT * FROM docs ORDER BY id LIMIT 100"
```
