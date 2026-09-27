-- type: online
-- resolves: user
-- source: RISK
select
    count(*) as txn_count_1h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 1 hour)
