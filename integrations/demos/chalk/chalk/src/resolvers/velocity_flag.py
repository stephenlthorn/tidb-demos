from chalk import online

from src.user import User


@online
def compute_velocity_flag(
    txn_count_1h: User.txn_count_1h,
) -> User.velocity_flag:
    from src.velocity import evaluate_velocity_flag

    return evaluate_velocity_flag(txn_count_1h)
