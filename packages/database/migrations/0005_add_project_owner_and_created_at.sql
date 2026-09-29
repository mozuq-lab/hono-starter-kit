alter table projects
  add column owner_user_id text not null references users (id),
  add column created_at timestamptz not null,
  add check (updated_at >= created_at);

create index projects_owner_created_at_idx
  on projects (owner_user_id, created_at desc, id desc);
