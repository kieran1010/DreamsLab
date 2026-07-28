-- =============================================================================
-- Synapse voucher system - schema
-- -----------------------------------------------------------------------------
-- Two tables and one function:
--
--   vouchers     the codes an admin creates. A code is dead once revoked,
--                past its redeem_by date, or fully redeemed.
--   redemptions  one row per successful redemption (a classroom code has
--                many). access_end is frozen at redemption time so shortening
--                a voucher later never strands students mid-course.
--   redeem_voucher(code)  the ONLY write path the public redeem endpoint
--                uses. SECURITY DEFINER + row lock makes the seat-count
--                check atomic under concurrent classroom sign-ups.
--
-- RLS: no anon access at all. The redeem Edge Function uses the service role
-- (bypasses RLS); the admin page uses an authenticated Supabase user.
-- IMPORTANT: disable public sign-ups in Authentication settings, otherwise
-- anyone who registers becomes an admin.
-- =============================================================================

create table if not exists public.vouchers (
    id              uuid primary key default gen_random_uuid(),
    -- Stored normalised: uppercase alphanumerics, no dashes. The admin UI
    -- displays it grouped (XXXX-XXXX-XXXX); the redeem endpoint strips
    -- whatever separators the user typed before lookup.
    code            text not null unique,
    label           text,                       -- e.g. "St Elsewhere FRCA course Sept 2026"
    tier            text not null default 'pro',
    max_redemptions integer,                    -- null = unlimited (classroom code)
    redeem_by       timestamptz,                -- code cannot be redeemed after this
    access_days     integer,                    -- access duration from moment of redemption
    access_until    timestamptz,                -- hard end date for access
    revoked         boolean not null default false,
    notes           text,
    created_at      timestamptz not null default now(),
    -- A voucher must define SOME end to the access it grants.
    constraint vouchers_access_defined check (access_days is not null or access_until is not null),
    constraint vouchers_code_format    check (code ~ '^[A-Z0-9]{8,32}$'),
    constraint vouchers_seats_positive check (max_redemptions is null or max_redemptions > 0)
);

create table if not exists public.redemptions (
    id          uuid primary key default gen_random_uuid(),
    voucher_id  uuid not null references public.vouchers(id) on delete cascade,
    redeemed_at timestamptz not null default now(),
    access_end  timestamptz not null,           -- frozen at redemption time
    client_id   text,                           -- random per-browser id, for spotting a leaked code
    user_agent  text
);

create index if not exists redemptions_voucher_idx on public.redemptions (voucher_id);

alter table public.vouchers    enable row level security;
alter table public.redemptions enable row level security;

-- Admin page access. Any authenticated user is an admin (sign-ups disabled).
create policy "authenticated full access" on public.vouchers
    for all to authenticated using (true) with check (true);
create policy "authenticated read" on public.redemptions
    for select to authenticated using (true);

-- Convenience view for the admin list: voucher + live usage stats.
-- security_invoker so the caller's RLS applies (anon still sees nothing).
create or replace view public.voucher_stats
    with (security_invoker = true) as
select v.*,
       count(r.id)        as redemption_count,
       max(r.redeemed_at) as last_redeemed_at
from public.vouchers v
left join public.redemptions r on r.voucher_id = v.id
group by v.id;

-- -----------------------------------------------------------------------------
-- redeem_voucher: validate + record a redemption atomically.
-- Raises INVALID_CODE / REVOKED / EXPIRED / FULLY_REDEEMED; the Edge Function
-- maps these onto user-facing messages. The FOR UPDATE row lock serialises
-- concurrent redemptions of the same code, so max_redemptions cannot be
-- oversubscribed by a classroom hitting the endpoint simultaneously.
-- -----------------------------------------------------------------------------
create or replace function public.redeem_voucher(
    p_code       text,
    p_client_id  text default null,
    p_user_agent text default null
)
returns table (access_end timestamptz, tier text, label text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v     vouchers%rowtype;
    used  integer;
    v_end timestamptz;
begin
    select * into v from vouchers where vouchers.code = p_code for update;
    if not found then
        raise exception 'INVALID_CODE';
    end if;
    if v.revoked then
        raise exception 'REVOKED';
    end if;
    if v.redeem_by is not null and now() > v.redeem_by then
        raise exception 'EXPIRED';
    end if;
    if v.max_redemptions is not null then
        select count(*) into used from redemptions where voucher_id = v.id;
        if used >= v.max_redemptions then
            raise exception 'FULLY_REDEEMED';
        end if;
    end if;

    -- Access ends at the earlier of the fixed end date and now + duration.
    -- The table constraint guarantees at least one of the two is set.
    v_end := least(
        coalesce(v.access_until, 'infinity'::timestamptz),
        coalesce(now() + make_interval(days => v.access_days), 'infinity'::timestamptz)
    );

    insert into redemptions (voucher_id, access_end, client_id, user_agent)
    values (v.id, v_end, p_client_id, p_user_agent);

    return query select v_end, v.tier, v.label;
end;
$$;

-- Only the service role (the redeem Edge Function) may call it.
revoke all on function public.redeem_voucher(text, text, text) from public;
revoke all on function public.redeem_voucher(text, text, text) from anon;
revoke all on function public.redeem_voucher(text, text, text) from authenticated;
grant execute on function public.redeem_voucher(text, text, text) to service_role;
