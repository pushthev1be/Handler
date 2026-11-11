-- handler: warehouse inventory
-- Stock is per client and per job code. Isolation is the same as everywhere else: every row
-- carries client_id, RLS filters by the JWT claim, and composite foreign keys stop a movement
-- from pointing at another client's item or order.
--
-- Clients and the AI can READ stock. Nothing the `authenticated` role can do writes it directly:
-- stock changes only through the SECURITY DEFINER functions below, which derive the client and
-- the quantity from the caller's own order (never from a parameter) and write the audit trail.
-- Receiving stock is a warehouse operation: it runs as the table owner / service role (seed).

-- composite key so movements can reference (order, client) together
alter table public.orders add constraint orders_id_client_key unique (id, client_id);

create table public.inventory_items (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id),
  job_code      text not null,
  location      text not null,
  on_hand       int  not null default 0 check (on_hand >= 0),
  reserved      int  not null default 0 check (reserved >= 0),
  reorder_point int  not null default 0 check (reorder_point >= 0),
  updated_at    timestamptz not null default now(),
  unique (client_id, job_code),
  unique (id, client_id),
  -- the database refuses to promise stock that is not on the shelf
  check (reserved <= on_hand)
);

-- Append-only ledger. A given order can reserve, release and ship at most once each,
-- which makes every stock function safe to retry.
create table public.inventory_movements (
  id          bigint generated always as identity primary key,
  client_id   uuid not null references public.clients (id),
  item_id     uuid not null,
  order_id    uuid,
  kind        text not null check (kind in ('receipt', 'reserve', 'release', 'ship')),
  quantity    int  not null check (quantity > 0),
  actor       text not null,
  occurred_at timestamptz not null default now(),
  foreign key (item_id, client_id) references public.inventory_items (id, client_id),
  foreign key (order_id, client_id) references public.orders (id, client_id)
);

create unique index inventory_movements_once_per_order on public.inventory_movements (order_id, kind)
  where order_id is not null;
create index inventory_movements_client_idx on public.inventory_movements (client_id, id desc);

create or replace function app.inventory_movements_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'inventory_movements is append-only: % rejected', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

create trigger inventory_movements_no_change before update or delete on public.inventory_movements
  for each row execute function app.inventory_movements_immutable();

alter table public.inventory_items     enable row level security;
alter table public.inventory_movements enable row level security;

create policy inventory_items_own on public.inventory_items
  for select to authenticated
  using (client_id = (select app.current_client_id()));

create policy inventory_movements_own on public.inventory_movements
  for select to authenticated
  using (client_id = (select app.current_client_id()));

-- The company sees stock across clients (low-stock and quarantine alerts). Still read-only.
create policy inventory_items_ops on public.inventory_items
  for select to authenticated
  using ((select app.is_ops()));

create policy inventory_movements_ops on public.inventory_movements
  for select to authenticated
  using ((select app.is_ops()));

-- What the client and the AI see: stock joined to whether the material is still current.
-- Stock of a material that is expired, withdrawn or superseded exists physically but must not
-- be shipped; material_current = false is the quarantine signal.
create view app.inventory_status with (security_invoker = true) as
select i.job_code,
       i.location,
       i.on_hand,
       i.reserved,
       i.on_hand - i.reserved as available,
       i.reorder_point,
       (i.on_hand - i.reserved) <= i.reorder_point as low_stock,
       (m.id is not null) as material_current,
       m.version as current_version,
       m.max_order_qty,
       (select d.title from public.documents d
         where d.client_id = i.client_id and d.job_code = i.job_code
         order by d.version desc limit 1) as title
  from public.inventory_items i
  left join app.current_materials m on m.client_id = i.client_id and m.job_code = i.job_code;

-- Shared guts: the caller's own order, or an error. The client comes from the verified claim.
create or replace function app.stock_order(p_order uuid) returns record
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_order record;
begin
  select o.id, o.client_id, o.job_code, o.quantity, o.status into v_order
    from public.orders o
   where o.id = p_order and o.client_id = app.current_client_id();
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;
  return v_order;
end
$$;

-- Reserve stock for an approved order. Returns false (and changes nothing) if there is not
-- enough available; true if reserved now or already reserved earlier (idempotent).
create or replace function app.reserve_stock(p_order uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order record;
  v_item  public.inventory_items;
begin
  v_order := app.stock_order(p_order);
  if v_order.status <> 'approved' then
    raise exception 'stock can only be reserved for an approved order' using errcode = 'check_violation';
  end if;

  select * into v_item from public.inventory_items i
   where i.client_id = v_order.client_id and i.job_code = v_order.job_code
   for update;
  if not found then
    return false;
  end if;

  if exists (select 1 from public.inventory_movements x where x.order_id = p_order and x.kind = 'reserve') then
    return true;
  end if;
  if v_item.on_hand - v_item.reserved < v_order.quantity then
    insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
    values (v_order.client_id, app.current_actor(), 'inventory.insufficient', 'order', p_order::text,
            jsonb_build_object('job_code', v_order.job_code, 'requested', v_order.quantity,
                               'available', v_item.on_hand - v_item.reserved), '', '');
    return false;
  end if;

  update public.inventory_items set reserved = reserved + v_order.quantity, updated_at = now()
   where id = v_item.id;
  insert into public.inventory_movements (client_id, item_id, order_id, kind, quantity, actor)
  values (v_order.client_id, v_item.id, p_order, 'reserve', v_order.quantity, app.current_actor());
  insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
  values (v_order.client_id, app.current_actor(), 'inventory.reserved', 'order', p_order::text,
          jsonb_build_object('job_code', v_order.job_code, 'quantity', v_order.quantity), '', '');
  return true;
end
$$;

-- Give reserved stock back (the warehouse rejected or could not be reached). Idempotent.
create or replace function app.release_stock(p_order uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order record;
  v_item  public.inventory_items;
begin
  v_order := app.stock_order(p_order);
  select * into v_item from public.inventory_items i
   where i.client_id = v_order.client_id and i.job_code = v_order.job_code
   for update;
  if not found
     or not exists (select 1 from public.inventory_movements x where x.order_id = p_order and x.kind = 'reserve')
     or exists (select 1 from public.inventory_movements x where x.order_id = p_order and x.kind in ('release', 'ship')) then
    return;
  end if;
  update public.inventory_items set reserved = reserved - v_order.quantity, updated_at = now()
   where id = v_item.id;
  insert into public.inventory_movements (client_id, item_id, order_id, kind, quantity, actor)
  values (v_order.client_id, v_item.id, p_order, 'release', v_order.quantity, app.current_actor());
  insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
  values (v_order.client_id, app.current_actor(), 'inventory.released', 'order', p_order::text,
          jsonb_build_object('job_code', v_order.job_code, 'quantity', v_order.quantity), '', '');
end
$$;

-- The warehouse reported the order shipped: stock physically leaves. Idempotent.
create or replace function app.ship_stock(p_order uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order record;
  v_item  public.inventory_items;
begin
  v_order := app.stock_order(p_order);
  if v_order.status <> 'submitted' then
    return;
  end if;
  select * into v_item from public.inventory_items i
   where i.client_id = v_order.client_id and i.job_code = v_order.job_code
   for update;
  if not found
     or not exists (select 1 from public.inventory_movements x where x.order_id = p_order and x.kind = 'reserve')
     or exists (select 1 from public.inventory_movements x where x.order_id = p_order and x.kind in ('release', 'ship')) then
    return;
  end if;
  update public.inventory_items
     set on_hand = on_hand - v_order.quantity, reserved = reserved - v_order.quantity, updated_at = now()
   where id = v_item.id;
  insert into public.inventory_movements (client_id, item_id, order_id, kind, quantity, actor)
  values (v_order.client_id, v_item.id, p_order, 'ship', v_order.quantity, app.current_actor());
  insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
  values (v_order.client_id, app.current_actor(), 'inventory.shipped', 'order', p_order::text,
          jsonb_build_object('job_code', v_order.job_code, 'quantity', v_order.quantity), '', '');
end
$$;

revoke all on all tables in schema public from anon;
revoke all on public.inventory_items, public.inventory_movements from authenticated;
grant select on public.inventory_items, public.inventory_movements to authenticated;
grant select on app.inventory_status to authenticated;
revoke execute on function app.stock_order(uuid) from public, anon, authenticated;
revoke execute on function app.reserve_stock(uuid), app.release_stock(uuid), app.ship_stock(uuid) from public, anon;
grant execute on function app.reserve_stock(uuid), app.release_stock(uuid), app.ship_stock(uuid) to authenticated;
