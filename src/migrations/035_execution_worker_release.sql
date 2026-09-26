alter table execution_workers
  add column if not exists release_ref text,
  add column if not exists worker_protocol integer not null default 1;

create index if not exists execution_workers_protocol_seen_idx
  on execution_workers(tenant_id,worker_protocol,last_seen desc);
