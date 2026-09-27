from datetime import datetime
from typing import Any, Mapping, Optional, Sequence

from lab_runner import tidb_connect_from_env

from src.baseline_sql import build_baseline_query
from src.schema import TRANSACTIONS_DDL, USERS_DDL
from src.workload import TransactionRow


def ensure_schema(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute(USERS_DDL)
        cur.execute(TRANSACTIONS_DDL)


def seed_users(env: Optional[Mapping[str, str]], user_ids: Sequence[int]) -> None:
    conn = tidb_connect_from_env(env)
    try:
        ensure_schema(conn)
        with conn.cursor() as cur:
            for user_id in user_ids:
                cur.execute(
                    "insert ignore into users (id, name) values (%s, %s)",
                    (user_id, f"user-{user_id}"),
                )
    finally:
        conn.close()


def insert_transaction(conn: Any, row: TransactionRow) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into transactions (user_id, merchant_id, amount) values (%s, %s, %s)",
            (row.user_id, row.merchant_id, row.amount_cents / 100.0),
        )


def _extract_value(row: Any) -> Any:
    if isinstance(row, Mapping):
        if "value" not in row:
            raise ValueError("baseline query result is missing the 'value' column")
        return row["value"]
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)):
        if len(row) == 0:
            raise ValueError("baseline query result row is empty")
        return row[0]
    raise ValueError(f"unexpected baseline query result shape: {type(row)!r}")


def run_baseline_query(conn: Any, feature_id: str, user_id: int, now: datetime) -> float:
    sql, params = build_baseline_query(feature_id, user_id, now)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"baseline query for {feature_id} returned no row")
        value = _extract_value(row)
        if value is None:
            raise RuntimeError(f"baseline query for {feature_id} returned a null value")
        return float(value)
