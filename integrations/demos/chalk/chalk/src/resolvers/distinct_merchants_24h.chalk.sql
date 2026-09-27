-- type: online
-- resolves: user
-- source: RISK
select
    count(distinct merchant_id) as distinct_merchants_24h
from transactions
where user_id = ${user.id}
  and created_at > date_sub(${now}, interval 24 hour)
