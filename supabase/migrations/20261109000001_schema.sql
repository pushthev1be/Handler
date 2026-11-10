-- handler: core schema
-- Every tenant-owned row carries client_id. Child tables use composite foreign keys
-- (id, client_id) so a row can never point at another client's parent.

create extension if not exists vector;

create schema if not exists app;

create table public.clients (
  id   uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  -- account code the client is known by in the legacy order system
  legacy_account text not null unique
);

-- One row per version of a piece of promotional / medical material.
-- "Current" is derived (see app.current_materials), never stored.
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id),
  job_code      text not null,
  version       int  not null check (version > 0),
  title         text not null,
  material_type text not null,
  status        text not null check (status in ('draft', 'approved', 'withdrawn')),
  approved_at   timestamptz,
  expires_at    timestamptz,
  max_order_qty int  not null default 250 check (max_order_qty > 0),
  body          text not null,
  created_at    timestamptz not null default now(),
  unique (client_id, job_code, version),
  unique (id, client_id),
  check (status <> 'approved' or approved_at is not null)
);

create table public.chunks (
  id          bigint generated always as identity primary key,
  document_id uuid not null,
  client_id   uuid not null,
  chunk_index int  not null,
  content     text not null,
  embedding   vector(512) not null,
  embedding_model text not null,
  foreign key (document_id, client_id) references public.documents (id, client_id) on delete cascade
);

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null,
  document_id      uuid not null,
  job_code         text not null,
  doc_version      int  not null,
  quantity         int  not null check (quantity > 0),
  ship_to          jsonb not null,
  notes            text,
  status           text not null default 'pending_approval'
                   check (status in ('pending_approval', 'approved', 'submitted', 'rejected', 'failed')),
  requested_by     text not null,
  decided_by      text,
  approval_meaning text,
  approval_reason  text,
  decided_at       timestamptz,
  legacy_ref       text,
  created_at       timestamptz not null default now(),
  foreign key (document_id, client_id) references public.documents (id, client_id),
  check (status = 'pending_approval' or (decided_by is not null and decided_at is not null))
);

create table public.request_log (
  id                bigint generated always as identity primary key,
  client_id         uuid not null references public.clients (id),
  request_id        uuid not null,
  prompt_version    text not null,
  model             text not null,
  input_tokens      int  not null,
  output_tokens     int  not null,
  cache_read_tokens int  not null default 0,
  cost_usd          numeric(12, 6) not null,
  latency_ms        int  not null,
  tool_calls        jsonb not null default '[]',
  stop_reason       text,
  created_at        timestamptz not null default now()
);

create index chunks_client_id_idx on public.chunks (client_id);
create index chunks_embedding_idx on public.chunks using hnsw (embedding vector_cosine_ops);
create index documents_client_job_idx on public.documents (client_id, job_code, version desc);
create index orders_client_id_idx on public.orders (client_id, created_at desc);
create index request_log_client_idx on public.request_log (client_id, created_at desc);

-- Compliance rule lives here, not in the prompt: a job code's current material is its
-- highest approved-or-withdrawn version, and only if that version is approved and unexpired.
-- security_invoker makes the caller's RLS apply through the view.
create view app.current_materials with (security_invoker = true) as
select d.*
from public.documents d
where d.status = 'approved'
  and d.approved_at <= now()
  and (d.expires_at is null or d.expires_at > now())
  and d.version = (
    select max(x.version)
    from public.documents x
    where x.client_id = d.client_id
      and x.job_code = d.job_code
      and x.status in ('approved', 'withdrawn')
  );
