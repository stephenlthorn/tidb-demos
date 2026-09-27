from src.velocity import VELOCITY_THRESHOLD, evaluate_velocity_flag


def test_flag_false_below_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD - 1) is False


def test_flag_true_at_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD) is True


def test_flag_true_above_threshold():
    assert evaluate_velocity_flag(txn_count_1h=VELOCITY_THRESHOLD + 10) is True


def test_custom_threshold_overrides_default():
    assert evaluate_velocity_flag(txn_count_1h=3, threshold=3) is True
    assert evaluate_velocity_flag(txn_count_1h=2, threshold=3) is False
