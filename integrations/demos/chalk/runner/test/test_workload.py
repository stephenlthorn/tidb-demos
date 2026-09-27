from src.workload import TransactionRow, next_transaction


def test_steady_state_produces_one_row_for_designated_user():
    row = next_transaction(user_id=1, tick=5, merchant_pool=["m1", "m2"], amount_cents=1234, burst=False)
    assert isinstance(row, TransactionRow)
    assert row.user_id == 1
    assert row.merchant_id in ("m1", "m2")
    assert row.amount_cents == 1234


def test_burst_mode_marks_the_row():
    row = next_transaction(user_id=9, tick=1, merchant_pool=["m1"], amount_cents=500, burst=True)
    assert row.burst is True


def test_merchant_pool_must_be_non_empty():
    try:
        next_transaction(user_id=1, tick=0, merchant_pool=[], amount_cents=100, burst=False)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "merchant_pool" in str(exc)


def test_row_is_immutable():
    row = next_transaction(user_id=1, tick=0, merchant_pool=["m1"], amount_cents=100, burst=False)
    try:
        row.amount_cents = 999  # type: ignore[misc]
        assert False, "expected FrozenInstanceError"
    except Exception:
        pass
