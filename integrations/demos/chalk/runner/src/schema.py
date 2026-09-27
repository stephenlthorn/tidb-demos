USERS_DDL = """
create table if not exists users (
    id bigint primary key,
    name varchar(128) not null
)
"""

TRANSACTIONS_DDL = """
create table if not exists transactions (
    id bigint auto_increment primary key,
    user_id bigint not null,
    merchant_id varchar(64) not null,
    amount decimal(12, 2) not null,
    created_at timestamp(3) not null default current_timestamp(3),
    key idx_user_created (user_id, created_at)
)
"""
