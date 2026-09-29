create table projects (
  id text primary key,
  name text not null check (length(btrim(name)) > 0),
  status text not null check (status in ('active', 'archived')),
  updated_at timestamptz not null
);
