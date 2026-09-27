from dataclasses import dataclass


@dataclass(frozen=True)
class TransactionRow:
    user_id: int
    tick: int
    merchant_id: str
    amount_cents: int
    burst: bool


def next_transaction(
    user_id: int,
    tick: int,
    merchant_pool: list[str],
    amount_cents: int,
    burst: bool,
) -> TransactionRow:
    if not merchant_pool:
        raise ValueError("merchant_pool must be non-empty")
    merchant_id = merchant_pool[tick % len(merchant_pool)]
    return TransactionRow(
        user_id=user_id,
        tick=tick,
        merchant_id=merchant_id,
        amount_cents=amount_cents,
        burst=burst,
    )
