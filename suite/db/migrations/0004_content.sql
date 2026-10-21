-- 0004_content.sql
-- Content, versions, assets, knowledge pages and client document rooms.

begin;

create table content_item (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  kind text not null
    check (kind in ('page', 'post', 'knowledge', 'sop', 'template')),
  slug text not null,
  title text not null,
  locale text not null default 'en',
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'published', 'archived')),
  seo jsonb not null default '{}'::jsonb,
  author_user_id uuid references app_user (id),
  reviewer_user_id uuid references app_user (id),
  current_version_id uuid,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, kind, slug, locale)
);

create index content_item_status_idx on content_item (tenant_id, kind, status)
  where deleted_at is null;

create table content_version (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  content_item_id uuid not null,
  version integer not null check (version > 0),
  title text not null,
  body jsonb not null default '{}'::jsonb,
  change_note text,
  created_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, content_item_id, version),
  foreign key (tenant_id, content_item_id) references content_item (tenant_id, id) on delete cascade
);

alter table content_item
  add constraint content_item_current_version_fk
  foreign key (tenant_id, current_version_id) references content_version (tenant_id, id);

create table asset (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_key text not null unique,
  checksum_sha256 text not null,
  width integer,
  height integer,
  tags text[] not null default '{}',
  rights_expiry date,
  scan_status text not null default 'pending'
    check (scan_status in ('pending', 'clean', 'infected', 'failed')),
  uploaded_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id)
);

create index asset_tags_idx on asset using gin (tags);
create index asset_expiry_idx on asset (tenant_id, rights_expiry)
  where deleted_at is null;

create table content_asset (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  content_item_id uuid not null,
  asset_id uuid not null,
  role text not null default 'attachment'
    check (role in ('hero', 'inline', 'attachment')),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, content_item_id, asset_id, role),
  foreign key (tenant_id, content_item_id) references content_item (tenant_id, id) on delete cascade,
  foreign key (tenant_id, asset_id) references asset (tenant_id, id)
);

create table document_room (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  name text not null,
  client_id uuid,
  project_id uuid,
  status text not null default 'open'
    check (status in ('open', 'archived')),
  created_by uuid references app_user (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, client_id) references client (tenant_id, id),
  foreign key (tenant_id, project_id) references project (tenant_id, id)
);

create table document_room_member (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant (id),
  room_id uuid not null,
  principal_type text not null check (principal_type in ('user', 'client_contact')),
  principal_id uuid not null,
  permission text not null default 'view'
    check (permission in ('view', 'comment', 'upload', 'manage')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, room_id, principal_type, principal_id),
  foreign key (tenant_id, room_id) references document_room (tenant_id, id) on delete cascade
);

create index document_room_member_principal_idx
  on document_room_member (tenant_id, principal_type, principal_id);

call app.enable_tenant_rls('content_item');
call app.enable_tenant_rls('content_version');
call app.enable_tenant_rls('asset');
call app.enable_tenant_rls('content_asset');
call app.enable_tenant_rls('document_room');
call app.enable_tenant_rls('document_room_member');

call app.add_updated_at('content_item');
call app.add_updated_at('document_room');

commit;
