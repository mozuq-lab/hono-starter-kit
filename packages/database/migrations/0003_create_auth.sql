create table users (
  id text primary key check (length(btrim(id)) > 0),
  email text,
  display_name text,
  roles text[] not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (updated_at >= created_at)
);

create table user_identities (
  issuer text not null check (length(btrim(issuer)) > 0),
  subject text not null check (length(btrim(subject)) > 0),
  provider text not null check (length(btrim(provider)) > 0),
  user_id text not null references users(id),
  created_at timestamptz not null,
  last_authenticated_at timestamptz not null,
  primary key (issuer, subject),
  check (last_authenticated_at >= created_at)
);

create index user_identities_user_id_idx on user_identities (user_id);

create table sessions (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id text not null references users(id),
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  created_at timestamptz not null,
  last_accessed_at timestamptz not null,
  revoked_at timestamptz,
  provider_session_id text,
  check (absolute_expires_at > created_at),
  check (idle_expires_at > created_at),
  check (idle_expires_at <= absolute_expires_at),
  check (last_accessed_at >= created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_active_expiry_idx
  on sessions (idle_expires_at, absolute_expires_at)
  where revoked_at is null;
