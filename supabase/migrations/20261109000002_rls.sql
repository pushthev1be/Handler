-- handler: tenant isolation
-- The tenant comes from the JWT's app_metadata.client_id. On Supabase, app_metadata is
-- writable only with the service role, so an end user cannot change their own tenant.

create or replace function app.current_client_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'client_id',
    ''
  )::uuid
$$;

create or replace function app.current_actor() returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    current_user
  )
$$;

alter table public.clients     enable row level security;
alter table public.documents   enable row level security;
alter table public.chunks      enable row level security;
alter table public.orders      enable row level security;
alter table public.request_log enable row level security;

-- force: the table owner is subject to the policies too (service_role keeps bypassrls)
alter table public.documents   force row level security;
alter table public.chunks      force row level security;
alter table public.orders      force row level security;
alter table public.request_log force row level security;

create policy clients_own on public.clients
  for select to authenticated
  using (id = (select app.current_client_id()));

create policy documents_own on public.documents
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy chunks_own on public.chunks
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy orders_select_own on public.orders
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy orders_insert_own on public.orders
  for insert to authenticated
  with check (client_id = (select app.current_client_id()) and status = 'pending_approval');

create policy orders_update_own on public.orders
  for update to authenticated
  using (client_id = (select app.current_client_id()))
  with check (client_id = (select app.current_client_id()));

create policy request_log_select_own on public.request_log
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy request_log_insert_own on public.request_log
  for insert to authenticated
  with check (client_id = (select app.current_client_id()));

-- Least privilege: authenticated can read materials, but only write orders and logs.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema app to authenticated;
grant select on public.clients, public.documents, public.chunks to authenticated;
grant select, insert on public.orders, public.request_log to authenticated;
grant update (status, decided_by, approval_meaning, approval_reason, decided_at, legacy_ref)
  on public.orders to authenticated;
grant select on app.current_materials to authenticated;
grant execute on function app.current_client_id(), app.current_actor() to authenticated;
