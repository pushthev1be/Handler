-- handler: order rules enforced in the database, independent of application code
--   * an order can only reference approved, current material, checked at creation AND at approval
--   * quantity is capped per material
--   * status moves only along: pending_approval -> approved|rejected, approved -> submitted|failed

create or replace function app.enforce_order_rules() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_doc record;
begin
  if tg_op = 'INSERT' then
    select m.job_code, m.version, m.max_order_qty into v_doc
      from app.current_materials m
     where m.id = new.document_id and m.client_id = new.client_id;
    if not found then
      raise exception 'material is not approved and current' using errcode = 'check_violation';
    end if;
    if new.quantity > v_doc.max_order_qty then
      raise exception 'quantity % exceeds limit % for %', new.quantity, v_doc.max_order_qty, v_doc.job_code
        using errcode = 'check_violation';
    end if;
    new.job_code := v_doc.job_code;
    new.doc_version := v_doc.version;
    new.status := 'pending_approval';
    new.created_at := now();
    return new;
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
    or (old.status = 'approved'         and new.status in ('submitted', 'failed'))
  ) then
    raise exception 'illegal order transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'pending_approval' and new.status = 'approved' then
    if not exists (select 1 from app.current_materials m
                    where m.id = new.document_id and m.client_id = new.client_id) then
      raise exception 'material % v% is no longer approved and current', old.job_code, old.doc_version
        using errcode = 'check_violation';
    end if;
    if new.decided_by is null or new.approval_meaning is null then
      raise exception 'approval requires signer and meaning' using errcode = 'check_violation';
    end if;
  end if;

  if old.status <> 'pending_approval' and (
       new.decided_by is distinct from old.decided_by
    or new.approval_meaning is distinct from old.approval_meaning
    or new.approval_reason is distinct from old.approval_reason
    or new.decided_at is distinct from old.decided_at) then
    raise exception 'signature fields are immutable once signed' using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger orders_rules before insert or update on public.orders
  for each row execute function app.enforce_order_rules();
