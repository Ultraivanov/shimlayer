-- ShimLayer MVP schema (Supabase/Postgres)
-- Run as migration in Supabase SQL editor or CLI.

create extension if not exists "uuid-ossp";

-- Supabase exposes auth.jwt(); define a local fallback for vanilla Postgres tests.
create schema if not exists auth;
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select '{}'::jsonb
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_type') then
    create type task_type as enum ('stuck_recovery', 'quick_judgment');
  end if;
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type task_status as enum
    ('queued', 'claimed', 'completed', 'failed', 'disputed', 'refunded');
  end if;
  if not exists (select 1 from pg_type where typname = 'artifact_type') then
    create type artifact_type as enum ('screenshot', 'logs', 'json_payload');
  end if;
  if not exists (select 1 from pg_type where typname = 'review_status') then
    create type review_status as enum
    ('auto_passed', 'manual_required', 'approved', 'rejected');
  end if;
  if not exists (select 1 from pg_type where typname = 'ledger_entry_type') then
    create type ledger_entry_type as enum
    ('topup', 'package_purchase', 'task_charge', 'refund', 'worker_payout', 'platform_fee');
  end if;
end $$;

do $$
begin
  alter type ledger_entry_type add value if not exists 'package_purchase';
exception
  when undefined_object then null;
end $$;

do $$
begin
  alter type ledger_entry_type add value if not exists 'stripe_topup';
exception
  when undefined_object then null;
end $$;

do $$
begin
  alter type ledger_entry_type add value if not exists 'stripe_refund_adjustment';
exception
  when undefined_object then null;
end $$;

create table if not exists public.accounts (
  id uuid primary key default uuid_generate_v4(),
  external_ref text unique,
  plan text not null default 'starter',
  balance_usd numeric(12,4) not null default 0,
  flow_credits integer not null default 0,
  webhook_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text not null,
  company text not null,
  role text,
  volume text,
  timeline text,
  usecase text,
  contact text,
  source text,
  page text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_created
  on public.leads(created_at desc);
create index if not exists idx_leads_email
  on public.leads(email);

alter table public.accounts
add column if not exists flow_credits integer not null default 0;

alter table public.accounts
alter column plan set default 'free';

create table if not exists public.package_catalog (
  code text primary key,
  flows integer not null check (flows > 0),
  price_usd numeric(12,4) not null check (price_usd > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.api_rate_windows (
  account_id uuid not null references public.accounts(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (account_id, window_start)
);

create index if not exists idx_api_rate_windows_window
  on public.api_rate_windows(window_start);

insert into public.package_catalog (code, flows, price_usd, active)
values
  ('indie_entry_150', 150, 255.00, true),
  ('growth_2000', 2000, 3360.00, true),
  ('scale_10000', 10000, 16500.00, true)
on conflict (code) do update
set flows = excluded.flows,
    price_usd = excluded.price_usd,
    active = excluded.active,
    updated_at = now();

create table if not exists public.tasks (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  worker_id uuid,
  task_type task_type not null,
  status task_status not null default 'queued',
  context jsonb not null default '{}'::jsonb,
  result jsonb,
  max_price_usd numeric(10,4) not null default 0.48,
  payout_usd numeric(10,4),
  callback_url text,
  review_required boolean not null default false,
  sla_seconds integer not null check (sla_seconds between 30 and 900),
  sla_deadline timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tasks_status_sla
  on public.tasks(status, sla_deadline);
create index if not exists idx_tasks_account_created
  on public.tasks(account_id, created_at desc);
create index if not exists idx_tasks_worker_status
  on public.tasks(worker_id, status);

create table if not exists public.artifacts (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  artifact_type artifact_type not null,
  storage_path text not null,
  checksum_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_artifacts_task
  on public.artifacts(task_id, created_at desc);

create table if not exists public.reviews (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null unique references public.tasks(id) on delete cascade,
  auto_check_provider text not null default 'heuristic',
  auto_check_model text,
  auto_check_score numeric(5,4) not null check (auto_check_score >= 0 and auto_check_score <= 1),
  auto_check_reason text,
  auto_check_redacted boolean,
  review_status review_status not null,
  manual_verdict text,
  refund_flag boolean not null default false,
  reviewed_by uuid,
  reviewed_at timestamptz,
  claimed_by text,
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_reviews_status
  on public.reviews(review_status, created_at desc);

alter table public.reviews add column if not exists claimed_by text;
alter table public.reviews add column if not exists claimed_until timestamptz;
alter table public.reviews add column if not exists auto_check_provider text;
alter table public.reviews add column if not exists auto_check_model text;
alter table public.reviews add column if not exists auto_check_reason text;
alter table public.reviews add column if not exists auto_check_redacted boolean;
create index if not exists idx_reviews_claim
  on public.reviews(review_status, claimed_until, created_at desc);

create table if not exists public.ledger (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  entry_type ledger_entry_type not null,
  amount_usd numeric(12,4) not null,
  currency text not null default 'USD',
  external_ref text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_account_created
  on public.ledger(account_id, created_at desc);
create index if not exists idx_ledger_task
  on public.ledger(task_id);

create table if not exists public.webhook_deliveries (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  callback_url text not null,
  status_code integer,
  attempt_no integer not null,
  success boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_deliveries_task_created
  on public.webhook_deliveries(task_id, created_at desc);

create table if not exists public.webhook_jobs (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  callback_url text not null,
  event_type text not null,
  payload jsonb not null,
  idempotency_key text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  status text not null default 'pending',
  last_status_code integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_webhook_jobs_status_next_attempt
  on public.webhook_jobs(status, next_attempt_at);

create table if not exists public.webhook_dead_letters (
  id uuid primary key default uuid_generate_v4(),
  webhook_job_id uuid not null references public.webhook_jobs(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  callback_url text not null,
  payload jsonb not null,
  error text,
  status_code integer,
  requeued_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.webhook_dead_letters
add column if not exists requeued_at timestamptz;

create index if not exists idx_webhook_dead_letters_task_created
  on public.webhook_dead_letters(task_id, created_at desc);

create table if not exists public.ops_task_audit (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor text not null,
  action text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_task_audit_task_created
  on public.ops_task_audit(task_id, created_at desc);

create table if not exists public.ops_incidents (
  id uuid primary key default uuid_generate_v4(),
  incident_type text not null,
  severity text not null,
  status text not null default 'open',
  title text not null,
  description text,
  owner text,
  source text not null default 'manual',
  postmortem text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_ops_incidents_status_updated
  on public.ops_incidents(status, updated_at desc);

create table if not exists public.ops_incident_events (
  id uuid primary key default uuid_generate_v4(),
  incident_id uuid not null references public.ops_incidents(id) on delete cascade,
  actor text not null,
  action text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ops_incident_events_incident_created
  on public.ops_incident_events(incident_id, created_at desc);

create table if not exists public.openai_interruptions (
  interruption_id text primary key,
  run_id text not null,
  thread_id text,
  agent_name text,
  tool_name text not null,
  task_id uuid not null references public.tasks(id) on delete cascade,
  status text not null default 'pending',
  decision text,
  decision_actor text,
  decision_note text,
  decision_output jsonb not null default '{}'::jsonb,
  context_capsule jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  state_blob text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  resumed_at timestamptz
);

create index if not exists idx_openai_interruptions_task
  on public.openai_interruptions(task_id, created_at desc);
create index if not exists idx_openai_interruptions_status
  on public.openai_interruptions(status, created_at desc);

create table if not exists public.stripe_events_processed (
  event_id text primary key,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);

create table if not exists public.stripe_customers (
  customer_id text primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_stripe_customers_account
  on public.stripe_customers(account_id);

create table if not exists public.stripe_subscriptions (
  subscription_id text primary key,
  customer_id text not null,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.prevent_ops_task_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ops_task_audit is immutable';
end;
$$;

drop trigger if exists trg_ops_task_audit_no_update on public.ops_task_audit;
create trigger trg_ops_task_audit_no_update
before update on public.ops_task_audit
for each row execute function public.prevent_ops_task_audit_mutation();

drop trigger if exists trg_ops_task_audit_no_delete on public.ops_task_audit;
create trigger trg_ops_task_audit_no_delete
before delete on public.ops_task_audit
for each row execute function public.prevent_ops_task_audit_mutation();

create or replace function public.prevent_ops_incident_events_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ops_incident_events is immutable';
end;
$$;

drop trigger if exists trg_ops_incident_events_no_update on public.ops_incident_events;
create trigger trg_ops_incident_events_no_update
before update on public.ops_incident_events
for each row execute function public.prevent_ops_incident_events_mutation();

drop trigger if exists trg_ops_incident_events_no_delete on public.ops_incident_events;
create trigger trg_ops_incident_events_no_delete
before delete on public.ops_incident_events
for each row execute function public.prevent_ops_incident_events_mutation();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
before update on public.accounts
for each row execute function public.set_updated_at();

drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

drop trigger if exists trg_reviews_updated_at on public.reviews;
create trigger trg_reviews_updated_at
before update on public.reviews
for each row execute function public.set_updated_at();

drop trigger if exists trg_package_catalog_updated_at on public.package_catalog;
create trigger trg_package_catalog_updated_at
before update on public.package_catalog
for each row execute function public.set_updated_at();

drop trigger if exists trg_webhook_jobs_updated_at on public.webhook_jobs;
create trigger trg_webhook_jobs_updated_at
before update on public.webhook_jobs
for each row execute function public.set_updated_at();

-- Enable RLS
alter table public.accounts enable row level security;
alter table public.tasks enable row level security;
alter table public.artifacts enable row level security;
alter table public.reviews enable row level security;
alter table public.ledger enable row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.package_catalog enable row level security;
alter table public.webhook_jobs enable row level security;
alter table public.webhook_dead_letters enable row level security;
alter table public.api_rate_windows enable row level security;
alter table public.ops_task_audit enable row level security;
alter table public.ops_incidents enable row level security;
alter table public.ops_incident_events enable row level security;
alter table public.openai_interruptions enable row level security;
alter table public.stripe_events_processed enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.stripe_subscriptions enable row level security;

-- Generic account isolation policy based on JWT claim "account_id".
drop policy if exists account_isolation_accounts on public.accounts;
create policy account_isolation_accounts on public.accounts
for all using (id = (auth.jwt() ->> 'account_id')::uuid);

drop policy if exists account_isolation_tasks on public.tasks;
create policy account_isolation_tasks on public.tasks
for all using (account_id = (auth.jwt() ->> 'account_id')::uuid);

drop policy if exists account_isolation_artifacts on public.artifacts;
create policy account_isolation_artifacts on public.artifacts
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = artifacts.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists account_isolation_reviews on public.reviews;
create policy account_isolation_reviews on public.reviews
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = reviews.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists account_isolation_ledger on public.ledger;
create policy account_isolation_ledger on public.ledger
for all using (account_id = (auth.jwt() ->> 'account_id')::uuid);

drop policy if exists account_isolation_webhook_deliveries on public.webhook_deliveries;
create policy account_isolation_webhook_deliveries on public.webhook_deliveries
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = webhook_deliveries.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists read_package_catalog on public.package_catalog;
create policy read_package_catalog on public.package_catalog
for select using (true);

drop policy if exists account_isolation_webhook_jobs on public.webhook_jobs;
create policy account_isolation_webhook_jobs on public.webhook_jobs
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = webhook_jobs.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists account_isolation_webhook_dead_letters on public.webhook_dead_letters;
create policy account_isolation_webhook_dead_letters on public.webhook_dead_letters
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = webhook_dead_letters.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists account_isolation_api_rate_windows on public.api_rate_windows;
create policy account_isolation_api_rate_windows on public.api_rate_windows
for all using (account_id = (auth.jwt() ->> 'account_id')::uuid);

drop policy if exists account_isolation_ops_task_audit on public.ops_task_audit;
create policy account_isolation_ops_task_audit on public.ops_task_audit
for all using (
  exists (
    select 1 from public.tasks t
    where t.id = ops_task_audit.task_id
      and t.account_id = (auth.jwt() ->> 'account_id')::uuid
  )
);

drop policy if exists deny_ops_incidents on public.ops_incidents;
create policy deny_ops_incidents on public.ops_incidents
for all using (false);

drop policy if exists deny_ops_incident_events on public.ops_incident_events;
create policy deny_ops_incident_events on public.ops_incident_events
for all using (false);

drop policy if exists deny_openai_interruptions on public.openai_interruptions;
create policy deny_openai_interruptions on public.openai_interruptions
for all using (false);

drop policy if exists deny_stripe_events_processed on public.stripe_events_processed;
create policy deny_stripe_events_processed on public.stripe_events_processed
for all using (false);

drop policy if exists deny_stripe_customers on public.stripe_customers;
create policy deny_stripe_customers on public.stripe_customers
for all using (false);

drop policy if exists deny_stripe_subscriptions on public.stripe_subscriptions;
create policy deny_stripe_subscriptions on public.stripe_subscriptions
for all using (false);
