from chalk.features import features


@features
class User:
    id: int
    txn_count_1h: int
    amount_sum_24h: float
    distinct_merchants_24h: int
    velocity_flag: bool
