alter table projects
add column version integer not null default 1 check (version > 0);
