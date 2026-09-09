-- =============================================================================
-- Synapse resources system - schema
-- -----------------------------------------------------------------------------
-- One table, one Storage bucket. Backs the admin.html "Resources" tab and the
-- Resources tab in index.html, which fetches this table directly (public
-- REST, anon key) instead of the git-committed resources/manifest.json it
-- used before.
--
-- RLS is the OPPOSITE way round from vouchers: this content is meant to be
-- public. Read access is open to anon (any site visitor); write access
-- (insert/update/delete) is authenticated-only (the admin page), exactly like
-- vouchers restricts ALL access to authenticated. Get this the wrong way
-- round and any site visitor can deface the resource list - double-check the
-- "to anon" / "to authenticated" on each policy below before applying.
-- =============================================================================

create table if not exists public.resources (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    -- Mirrors resources/manifest.json's shape (see resources/README.md,
    -- superseded by this table once the migration to Supabase is live).
    type        text not null check (type in ('pdf', 'video', 'link')),
    -- Either a public Storage URL (files uploaded via the admin page) or an
    -- external URL (YouTube etc. - required for video: Storage has the same
    -- "don't put video files here" reasoning git did, see resources/README.md
    -- history, though Storage itself has no 100MB-style hard limit).
    url         text not null,
    description text,
    created_at  timestamptz not null default now()
);

alter table public.resources enable row level security;

-- Admin page access (same "any authenticated user is an admin, sign-ups
-- disabled" model as vouchers - see supabase/README.md).
create policy "authenticated full access" on public.resources
    for all to authenticated using (true) with check (true);

-- Public read: this is the one table in this project anon may read at all.
create policy "public read" on public.resources
    for select to anon using (true);

-- -----------------------------------------------------------------------------
-- Storage: a public bucket for uploaded files (PDFs etc.). "public" makes
-- reads work via the direct /storage/v1/object/public/resources/<path> URL
-- with no auth header needed - the same freely-linkable-URL behaviour the
-- git-hosted resources/ folder had. It does NOT bypass RLS for uploads -
-- write access is still gated by the storage.objects policies below.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('resources', 'resources', true)
on conflict (id) do nothing;

create policy "resources bucket authenticated full access" on storage.objects
    for all to authenticated
    using (bucket_id = 'resources')
    with check (bucket_id = 'resources');

create policy "resources bucket public read" on storage.objects
    for select to anon
    using (bucket_id = 'resources');
