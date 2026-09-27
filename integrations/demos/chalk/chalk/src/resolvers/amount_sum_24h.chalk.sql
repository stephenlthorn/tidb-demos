-- type: online
-- resolves: user
-- source: RISK
select
    coalesce(sum(amount), 0) as amount_sum_24h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 24 hour)
