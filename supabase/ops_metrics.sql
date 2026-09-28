-- 운영 브리핑 에이전트: 집계 전용 RPC
-- Supabase 대시보드 > SQL Editor 에 **그대로 붙여 실행**한다.
--
-- 왜 이 함수가 필요한가 (DECISIONS.md D10)
--   운영 브리핑은 전체 사용자 지표를 봐야 하는데, anon 키 + RLS 로는 본인 행만 보인다
--   (실제로 anon 키로 owned_items 를 조회하면 [] 가 돌아온다 — 정상이다).
--   그렇다고 service_role 키를 에이전트에 주면 모든 행에 접근하게 된다.
--   그래서 **집계값만 돌려주는 security definer 함수**를 하나 만들고, 에이전트에게는
--   이 함수를 부를 권한만 준다. 원시 행과 개인정보는 이 함수 밖으로 나가지 않는다.
--
-- 왜 토큰 인자가 있는가 (DECISIONS.md D20)
--   anon 키는 브라우저로 내려가는 공개 값이다. security definer 함수를 anon 에게
--   그냥 열어 주면 anon 키를 가진 누구나 전체 가입자 수를 읽을 수 있다.
--   그래서 public 스키마 밖(PostgREST 가 노출하지 않는 private 스키마)에 둔 비밀값과
--   대조한다. 에이전트는 .env.local 의 OPS_METRICS_TOKEN 으로 그 값을 넘긴다.
--
-- 지표 정의를 여기 박아 둔다 (Day 38 교훈 — 정의가 코드 밖에 있으면 회차마다 달라진다)
--   signups       : auth.users.created_at 이 그 날짜인 계정 수
--   owned_created : owned_items.created_at 이 그 날짜인 행 수
--   wish_created  : wishlist_items.created_at 이 그 날짜인 행 수
--   active_users  : 그 날짜에 있템/위시를 만들거나 고친 **서로 다른** 사용자 수.
--                   기간 합계는 날짜별 합이 아니라 기간 전체의 distinct 수다.
--                   조회만 한 사용자는 계측이 없어 여기 포함되지 않는다 (README 남은 과제).
--   errors_total  : 그 기간 public.error_logs 행 수 (처리되지 않은 라우트 에러·Server Action 실패).
--                   message/user_id 는 절대 내보내지 않는다 — route 이름과 건수만으로
--                   "어디서 많이 터지는지"를 본다. 테이블이 없으면 null + unavailable_fields.

-- 1. 비밀값 보관 --------------------------------------------------------------
-- private 스키마는 PostgREST 가 노출하지 않는다. REST 로는 이 테이블을 읽을 수 없다.
create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.ops_config (
  key   text primary key,
  value text not null
);

-- ↓↓↓ 이 줄의 값을 직접 정한 임의 문자열로 바꿔 실행하고, 같은 값을
--     .env.local 의 OPS_METRICS_TOKEN 에 넣는다. (아무도 모르는 긴 문자열이면 된다)
insert into private.ops_config (key, value)
values ('ops_metrics_token', 'CHANGE-ME-TO-A-LONG-RANDOM-STRING')
on conflict (key) do update set value = excluded.value;

-- 2. 집계 함수 ----------------------------------------------------------------
-- 반환형이 jsonb 집계값이다. 행 집합(setof)을 반환하지 않으므로
-- **원시 행 반환이 시그니처 차원에서 불가능하다.**
create or replace function public.ops_user_metrics(
  p_token       text,
  p_since       date,
  p_until       date,
  p_granularity text default 'day'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_expected text;
  v_span     integer;
  v_prev_since date;
  v_series   jsonb;
  v_totals   jsonb;
  v_prev     jsonb;
  v_has_err  boolean;
  v_err_routes jsonb;
  v_unavail  jsonb := '[]'::jsonb;
begin
  -- 권한 확인이 가장 먼저다. 통과하지 못하면 아무것도 계산하지 않는다.
  -- 토큰 대조는 상수 시간 비교가 아니다. 이 규모에서는 Supabase 쪽 호출 제한에 맡긴다.
  select value into v_expected from private.ops_config where key = 'ops_metrics_token';
  if v_expected is null or p_token is null or p_token <> v_expected then
    raise exception 'ops_metrics_token 이 일치하지 않는다'
      using errcode = '42501';   -- insufficient_privilege
  end if;

  if p_until <= p_since then
    raise exception 'p_until 은 p_since 보다 뒤여야 한다' using errcode = '22023';
  end if;
  if p_granularity not in ('day', 'week') then
    raise exception 'p_granularity 는 day 또는 week 여야 한다' using errcode = '22023';
  end if;

  v_span := p_until - p_since;
  v_prev_since := p_since - v_span;

  -- error_logs 가 없는 DB(구 마이그레이션)에서도 함수가 죽지 않게 한다.
  -- 없으면 에러 지표는 null + unavailable_fields 로 알린다. 0 으로 채우지 않는다.
  v_has_err := (to_regclass('public.error_logs') is not null);
  if not v_has_err then
    v_unavail := '["error_logs"]'::jsonb;
    v_err_routes := '[]'::jsonb;
  end if;

  -- 날짜별 시계열. 데이터가 없는 날도 0 으로 채운다 —
  -- 빠진 날짜를 결측으로 오해하지 않게 한다 (0 과 결측의 구별).
  with cal as (
    select generate_series(p_since, p_until - 1, interval '1 day')::date as d
  ),
  su as (
    select created_at::date as d, count(*) as n
    from auth.users where created_at >= p_since and created_at < p_until group by 1
  ),
  ow as (
    select created_at::date as d, count(*) as n
    from public.owned_items where created_at >= p_since and created_at < p_until group by 1
  ),
  wi as (
    select created_at::date as d, count(*) as n
    from public.wishlist_items where created_at >= p_since and created_at < p_until group by 1
  ),
  act as (
    select d, count(distinct user_id) as n from (
      select updated_at::date as d, user_id from public.owned_items
        where updated_at >= p_since and updated_at < p_until
      union all
      select updated_at::date as d, user_id from public.wishlist_items
        where updated_at >= p_since and updated_at < p_until
    ) t group by d
  )
  select jsonb_agg(jsonb_build_object(
           'date', cal.d,
           'signups', coalesce(su.n, 0),
           'owned_created', coalesce(ow.n, 0),
           'wish_created', coalesce(wi.n, 0),
           'active_users', coalesce(act.n, 0)
         ) order by cal.d)
    into v_series
  from cal
    left join su  on su.d  = cal.d
    left join ow  on ow.d  = cal.d
    left join wi  on wi.d  = cal.d
    left join act on act.d = cal.d;

  -- 기간 합계. active_users 는 날짜별 합이 아니라 기간 전체의 distinct 수다.
  select jsonb_build_object(
    'signups', (select count(*) from auth.users
                 where created_at >= p_since and created_at < p_until),
    'owned_created', (select count(*) from public.owned_items
                 where created_at >= p_since and created_at < p_until),
    'wish_created', (select count(*) from public.wishlist_items
                 where created_at >= p_since and created_at < p_until),
    'active_users', (select count(distinct user_id) from (
                 select user_id from public.owned_items
                   where updated_at >= p_since and updated_at < p_until
                 union all
                 select user_id from public.wishlist_items
                   where updated_at >= p_since and updated_at < p_until) t),
    'errors_total', case when v_has_err then
                 (select count(*) from public.error_logs
                   where created_at >= p_since and created_at < p_until)
               else null end
  ) into v_totals;

  -- 직전 같은 길이 기간. 이 값이 있어야 "늘었다/줄었다"를 말할 수 있다.
  select jsonb_build_object(
    'signups', (select count(*) from auth.users
                 where created_at >= v_prev_since and created_at < p_since),
    'owned_created', (select count(*) from public.owned_items
                 where created_at >= v_prev_since and created_at < p_since),
    'wish_created', (select count(*) from public.wishlist_items
                 where created_at >= v_prev_since and created_at < p_since),
    'active_users', (select count(distinct user_id) from (
                 select user_id from public.owned_items
                   where updated_at >= v_prev_since and updated_at < p_since
                 union all
                 select user_id from public.wishlist_items
                   where updated_at >= v_prev_since and updated_at < p_since) t),
    'errors_total', case when v_has_err then
                 (select count(*) from public.error_logs
                   where created_at >= v_prev_since and created_at < p_since)
               else null end
  ) into v_prev;

  -- 에러 다발 route 상위 5개. message/user_id 는 절대 내보내지 않는다.
  if v_has_err then
    select coalesce(jsonb_agg(jsonb_build_object('route', route, 'count', n)
                              order by n desc, route), '[]'::jsonb)
      into v_err_routes
      from (select route, count(*) as n from public.error_logs
             where created_at >= p_since and created_at < p_until
             group by route order by n desc, route limit 5) t;

    -- 일자별 에러 건수를 series 원소에 합친다. 없는 날은 0 으로 채운다.
    declare
      v_err_map jsonb;
      v_len     integer;
      v_i       integer;
      v_d       text;
    begin
      select coalesce(jsonb_object_agg(d::text, n), '{}'::jsonb) into v_err_map
        from (select created_at::date as d, count(*) as n from public.error_logs
               where created_at >= p_since and created_at < p_until group by 1) t;
      v_len := coalesce(jsonb_array_length(v_series), 0);
      for v_i in 0..v_len - 1 loop
        v_d := v_series -> v_i ->> 'date';
        v_series := jsonb_set(v_series, array[v_i::text, 'errors'],
                              to_jsonb(coalesce((v_err_map ->> v_d)::int, 0)));
      end loop;
    end;
  end if;

  return jsonb_build_object(
    'period', jsonb_build_object('since', p_since, 'until', p_until,
                                 'granularity', p_granularity),
    'series', coalesce(v_series, '[]'::jsonb),
    'totals', v_totals,
    'previous_period_totals', v_prev,
    'errors_by_route', v_err_routes,
    'unavailable_fields', v_unavail,
    'metric_definitions', jsonb_build_object(
      'active_users', '그 기간에 있템/위시를 만들거나 고친 서로 다른 사용자 수. 조회만 한 사용자는 계측이 없어 빠진다',
      'signups', 'auth.users.created_at 기준 신규 계정 수',
      'errors_total', '그 기간 error_logs 행 수. message/user_id 는 내보내지 않고 route·건수만 본다',
      'errors_by_route', '그 기간 에러가 많은 route 상위 5개와 건수'
    )
  );
end;
$$;

-- 3. 권한 ---------------------------------------------------------------------
-- 에이전트는 anon 키로 이 함수만 부른다. 테이블 직접 접근 권한은 주지 않는다.
revoke all on function public.ops_user_metrics(text, date, date, text) from public;
grant execute on function public.ops_user_metrics(text, date, date, text) to anon, authenticated;

comment on function public.ops_user_metrics(text, date, date, text) is
  '운영 브리핑용 집계 전용 함수. jsonb 집계값만 반환하며 원시 행과 개인정보는 반환하지 않는다.';
