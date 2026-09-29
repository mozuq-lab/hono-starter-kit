create table external_login_transactions (
  state_hash text primary key,
  nonce_hash text not null,
  verifier_hash text not null,
  return_to text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index external_login_transactions_expires_at_idx
  on external_login_transactions (expires_at);
