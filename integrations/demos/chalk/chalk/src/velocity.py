VELOCITY_THRESHOLD = 10


def evaluate_velocity_flag(txn_count_1h: int, threshold: int = VELOCITY_THRESHOLD) -> bool:
    return txn_count_1h >= threshold
