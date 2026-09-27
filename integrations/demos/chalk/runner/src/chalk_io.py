import os
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from chalk.client import ChalkClient

CHALK_BRANCH = "chalk-tidb-demo"

FEATURE_OUTPUTS = [
    "user.txn_count_1h",
    "user.amount_sum_24h",
    "user.distinct_merchants_24h",
    "user.velocity_flag",
]


@dataclass(frozen=True)
class ChalkFeatureResult:
    txn_count_1h: int
    amount_sum_24h: float
    distinct_merchants_24h: int
    velocity_flag: bool
    cache_hit: bool


def build_chalk_client(env: Optional[Mapping[str, str]] = None) -> ChalkClient:
    source = env if env is not None else os.environ
    client_id = source.get("CHALK_CLIENT_ID")
    client_secret = source.get("CHALK_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ValueError("CHALK_CLIENT_ID and CHALK_CLIENT_SECRET must be set")
    api_server = source.get("CHALK_API_HOST") or None
    return ChalkClient(
        client_id=client_id,
        client_secret=client_secret,
        environment=source.get("CHALK_ENVIRONMENT", "dev"),
        api_server=api_server,
        branch=CHALK_BRANCH,
    )


def _feature_value(values: Mapping[str, Any], field: str) -> Any:
    if field not in values:
        raise ValueError(f"Chalk response missing feature: {field}")
    return values[field]


def _cache_hit(result: Any) -> bool:
    feature = result.get_feature("user.txn_count_1h")
    if feature is None or feature.meta is None:
        return False
    return bool(feature.meta.cache_hit)


def query_user_features(client: ChalkClient, user_id: int, fresh: bool) -> ChalkFeatureResult:
    staleness = {feature: "0s" for feature in FEATURE_OUTPUTS} if fresh else None
    kwargs: dict[str, Any] = {
        "input": {"user.id": user_id},
        "output": FEATURE_OUTPUTS,
        "include_meta": True,
    }
    if staleness is not None:
        kwargs["staleness"] = staleness

    result = client.query(**kwargs)
    if result.errors:
        raise RuntimeError(f"Chalk query returned errors: {result.errors}")

    values = {row.field: row.value for row in result.data}
    return ChalkFeatureResult(
        txn_count_1h=int(_feature_value(values, "user.txn_count_1h")),
        amount_sum_24h=float(_feature_value(values, "user.amount_sum_24h")),
        distinct_merchants_24h=int(_feature_value(values, "user.distinct_merchants_24h")),
        velocity_flag=bool(_feature_value(values, "user.velocity_flag")),
        cache_hit=_cache_hit(result),
    )
