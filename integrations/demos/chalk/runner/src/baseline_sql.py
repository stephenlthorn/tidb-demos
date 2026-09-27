from datetime import datetime, timedelta
from typing import Any

_WINDOWS: dict[str, timedelta] = {
    "txn-count-1h": timedelta(hours=1),
    "amount-sum-24h": timedelta(hours=24),
    "distinct-merchants-24h": timedelta(hours=24),
}

_SELECTS: dict[str, str] = {
    "txn-count-1h": "select count(*) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
    "amount-sum-24h": "select coalesce(sum(amount), 0) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
    "distinct-merchants-24h": "select count(distinct merchant_id) as value from transactions where user_id = %(user_id)s and created_at > %(window_start)s",
}


def build_baseline_query(feature_id: str, user_id: int, now: datetime) -> tuple[str, dict[str, Any]]:
    if feature_id not in _WINDOWS:
        raise ValueError(f"unknown baseline feature id: {feature_id}")
    window_start = now - _WINDOWS[feature_id]
    return _SELECTS[feature_id], {"user_id": user_id, "window_start": window_start}
