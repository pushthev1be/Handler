-- handler: company-wide operations view
-- A user whose JWT carries app_metadata.role = 'ops' and no client_id can read orders, the
-- audit trail and the request log across all clients. Nothing else changes:
--   * no policy lets ops read documents or chunks, so material content stays per-client and
--     an ops session handed to the AI would find nothing to search;
--   * every insert/update policy requires app.current_client_id(), which is null for ops,
--     so ops cannot draft, sign, or write audit entries.
-- Like client_id, app_metadata.role is writable only with the service role on Supabase.

create or replace function app.is_ops() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'role' = 'ops'
      and app.current_client_id() is null,
    false
  )
$$;

create policy clients_ops on public.clients
  for select to authenticated
  using ((select app.is_ops()));

create policy orders_select_ops on public.orders
  for select to authenticated
  using ((select app.is_ops()));

create policy audit_select_ops on public.audit_log
  for select to authenticated
  using ((select app.is_ops()));

create policy request_log_select_ops on public.request_log
  for select to authenticated
  using ((select app.is_ops()));

grant execute on function app.is_ops() to authenticated;
