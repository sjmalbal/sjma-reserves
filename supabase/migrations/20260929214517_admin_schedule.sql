-- Operational scheduling is isolated from the existing SJMA tables.
alter table public.sjma_reservas_bookings
  drop constraint sjma_reservas_bookings_state_check;
alter table public.sjma_reservas_bookings
  add constraint sjma_reservas_bookings_state_check
  check (state in ('pending', 'confirmed', 'declined', 'failed', 'cancelled'));
alter table public.sjma_reservas_bookings
  add column source text not null default 'public'
  check (source in ('public', 'admin'));
alter table public.sjma_reservas_rooms
  add column booking_rules jsonb not null default '{}'::jsonb
  check (jsonb_typeof(booking_rules) = 'object');

create table public.sjma_reservas_blocks (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  group_id text not null check (group_id ~ '^[a-f0-9]{32}$'),
  room_email text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  label text not null check (length(label) between 1 and 120),
  kind text not null check (kind in ('block', 'holiday')),
  created_by text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint sjma_reservas_blocks_time_order check (starts_at < ends_at),
  constraint sjma_reservas_blocks_no_overlap exclude using gist (
    room_email with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (cancelled_at is null)
);
create index sjma_reservas_blocks_period_idx
  on public.sjma_reservas_blocks (starts_at, ends_at) where cancelled_at is null;
create index sjma_reservas_blocks_group_idx on public.sjma_reservas_blocks (group_id);

create table public.sjma_reservas_audit (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  actor_email text not null,
  action text not null,
  target_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sjma_reservas_audit_created_idx on public.sjma_reservas_audit (created_at desc);

alter table public.sjma_reservas_blocks enable row level security;
alter table public.sjma_reservas_audit enable row level security;
revoke all on public.sjma_reservas_blocks, public.sjma_reservas_audit
  from public, anon, authenticated;
grant select, insert, update, delete on public.sjma_reservas_blocks,
  public.sjma_reservas_audit to service_role;
