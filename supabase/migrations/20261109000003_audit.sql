-- handler: append-only, hash-chained audit trail (21 CFR Part 11 §11.10(e))
-- Each client has its own chain: hash = sha256(prev_hash | row fields). UPDATE, DELETE and
-- TRUNCATE are rejected by triggers and not granted. A superuser can still disable triggers;
-- the hash chain makes that detectable via app.verify_audit_chain().

create table public.audit_log (
  id          bigint generated always as identity primary key,
  client_id   uuid not null references public.clients (id),
  occurred_at timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}',
  prev_hash   text not null,
  hash        text not null
);

create index audit_log_client_idx on public.audit_log (client_id, id);

create or replace function app.audit_row_hash(
  p_prev_hash text, p_id bigint, p_client_id uuid, p_occurred_at timestamptz,
  p_actor text, p_action text, p_entity text, p_entity_id text, p_details jsonb
) returns text
language sql immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(concat_ws('|',
    p_prev_hash, p_id::text, p_client_id::text,
    to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_actor, p_action, p_entity, coalesce(p_entity_id, ''), p_details::text
  ), 'UTF8')), 'hex')
$$;

create or replace function app.audit_chain() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev text;
begin
  -- serialise appends per client so the chain stays linear
  perform pg_advisory_xact_lock(hashtextextended('audit:' || new.client_id::text, 0));
  select a.hash into v_prev
    from public.audit_log a
   where a.client_id = new.client_id
   order by a.id desc
   limit 1;
  new.occurred_at := clock_timestamp();
  new.prev_hash := coalesce(v_prev, 'GENESIS');
  new.hash := app.audit_row_hash(new.prev_hash, new.id, new.client_id, new.occurred_at,
                                 new.actor, new.action, new.entity, new.entity_id, new.details);
  return new;
end
$$;

create or replace function app.audit_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only: % rejected', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_log_chain before insert on public.audit_log
  for each row execute function app.audit_chain();
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function app.audit_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function app.audit_immutable();

-- Returns the id of the first row whose hash or link is wrong, or null if the chain is intact.
create or replace function app.verify_audit_chain(p_client_id uuid) returns bigint
language sql stable
set search_path = ''
as $$
  with ordered as (
    select a.*, lag(a.hash) over (order by a.id) as expected_prev
      from public.audit_log a
     where a.client_id = p_client_id
  )
  select min(id) from ordered
   where prev_hash <> coalesce(expected_prev, 'GENESIS')
      or hash <> app.audit_row_hash(prev_hash, id, client_id, occurred_at,
                                    actor, action, entity, entity_id, details)
$$;

-- Order changes are audited by the database, so no code path can skip them.
create or replace function app.audit_orders() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
  values (
    new.client_id,
    app.current_actor(),
    case when tg_op = 'INSERT' then 'order.created' else 'order.' || new.status end,
    'order',
    new.id::text,
    jsonb_build_object(
      'job_code', new.job_code, 'doc_version', new.doc_version, 'quantity', new.quantity,
      'status', new.status, 'previous_status', case when tg_op = 'UPDATE' then old.status end,
      'decided_by', new.decided_by, 'approval_meaning', new.approval_meaning,
      'approval_reason', new.approval_reason, 'legacy_ref', new.legacy_ref
    ),
    '', ''
  );
  return new;
end
$$;

create trigger orders_audit after insert or update on public.orders
  for each row execute function app.audit_orders();

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

create policy audit_select_own on public.audit_log
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy audit_insert_own on public.audit_log
  for insert to authenticated
  with check (client_id = (select app.current_client_id()));

grant select, insert on public.audit_log to authenticated;
grant execute on function app.verify_audit_chain(uuid) to authenticated;
