-- Private reservation data for the SJMA application. Existing SJMA tables are untouched.
create extension if not exists btree_gist with schema extensions;

create table public.sjma_reservas_rooms (
  resource_email text primary key check (resource_email = lower(resource_email)),
  room_id text not null unique,
  published boolean not null default false,
  title text not null check (length(title) between 1 and 120),
  features text[] not null default '{}',
  photos text[] not null default '{}',
  address text,
  updated_at timestamptz not null default now(),
  constraint sjma_reservas_rooms_photo_limit check (cardinality(photos) <= 12)
);

create table public.sjma_reservas_bookings (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  room_email text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  requester_name text not null,
  requester_last_name text not null default '',
  requester_email text not null,
  instrument text not null default '',
  relation text not null default '',
  note text not null default '',
  room_name text not null default '',
  state text not null check (state in ('pending', 'confirmed', 'declined', 'failed')),
  requester_mail_state text not null default 'unsent' check (requester_mail_state in ('unsent','sending','sent','failed','unknown')),
  secretariat_mail_state text not null default 'unsent' check (secretariat_mail_state in ('unsent','sending','sent','failed','unknown')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint sjma_reservas_bookings_time_order check (starts_at < ends_at),
  constraint sjma_reservas_bookings_no_overlap exclude using gist (
    room_email with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (state in ('pending','confirmed'))
);
create index sjma_reservas_bookings_created_idx on public.sjma_reservas_bookings (created_at desc);

create table public.sjma_reservas_admin_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  verifier text not null,
  expires_at timestamptz not null
);
create index sjma_reservas_admin_states_expiry_idx on public.sjma_reservas_admin_oauth_states (expires_at);

create table public.sjma_reservas_admin_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  email text not null,
  csrf text not null,
  expires_at timestamptz not null
);
create index sjma_reservas_admin_sessions_expiry_idx on public.sjma_reservas_admin_sessions (expires_at);

alter table public.sjma_reservas_rooms enable row level security;
alter table public.sjma_reservas_bookings enable row level security;
alter table public.sjma_reservas_admin_oauth_states enable row level security;
alter table public.sjma_reservas_admin_sessions enable row level security;

revoke all on public.sjma_reservas_rooms,
  public.sjma_reservas_bookings,
  public.sjma_reservas_admin_oauth_states,
  public.sjma_reservas_admin_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.sjma_reservas_rooms,
  public.sjma_reservas_bookings,
  public.sjma_reservas_admin_oauth_states,
  public.sjma_reservas_admin_sessions to service_role;
