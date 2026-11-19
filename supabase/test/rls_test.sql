-- Checks the security rules in schema.sql. Each block runs as a different user.
\set ON_ERROR_STOP 1
\set arjun '11111111-1111-1111-1111-111111111111'
\set riya  '22222222-2222-2222-2222-222222222222'
\set out   '33333333-3333-3333-3333-333333333333'
create temp table ctx(ws uuid, code text); grant all on ctx to authenticated;

-- Arjun creates a workspace and becomes admin
set role authenticated; select set_config('request.jwt.claim.sub', :'arjun', false);
insert into ctx select id, join_code from public.create_workspace('Kitebird Money', '{"rules":[],"brand":"Kitebird"}', 'Arjun');
select 'admin role: ' || public.my_role((select ws from ctx));

-- Riya joins with the code as a creator
select set_config('request.jwt.claim.sub', :'riya', false);
select public.join_workspace((select lower(code) from ctx), 'Riya') is not null as joined;
select 'riya role: ' || public.my_role((select ws from ctx));

-- Riya submits an item (allowed) ...
insert into public.items (id, workspace_id, data) values ('item0001', (select ws from ctx), '{"status":"in_review","title":"Post"}');
-- ... but cannot approve it
do $$ begin
  update public.items set data = jsonb_set(data, '{status}', '"approved"') where id = 'item0001';
  raise exception 'FAIL: creator approved';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: creator cannot approve (%)', sqlerrm; end $$;
-- ... and cannot edit the brand kit (update silently matches no rows under RLS)
update public.workspaces set kit = '{"rules":[],"hacked":true}' where id = (select ws from ctx);
select 'kit untouched by creator: ' || ((select kit->>'hacked' from public.workspaces where id = (select ws from ctx)) is null);
-- ... and cannot make herself admin
do $$ begin
  perform public.set_member_role((select ws from ctx), '22222222-2222-2222-2222-222222222222', 'admin');
  raise exception 'FAIL: creator changed role';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: creator cannot change roles'; end $$;

-- Arjun approves it and edits the kit
select set_config('request.jwt.claim.sub', :'arjun', false);
update public.items set data = jsonb_set(data, '{status}', '"approved"') where id = 'item0001';
select 'status column follows json: ' || status from public.items where id = 'item0001';
update public.workspaces set kit = '{"rules":[],"version":2}' where id = (select ws from ctx);
select 'kit version: ' || (kit->>'version') from public.workspaces where id = (select ws from ctx);
-- Arjun can't remove the last admin (himself)
do $$ begin
  perform public.set_member_role((select ws from ctx), '11111111-1111-1111-1111-111111111111', 'creator');
  raise exception 'FAIL: removed last admin';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: last admin protected'; end $$;
-- Riya can comment on the approved item (an upsert that keeps the status) ...
select set_config('request.jwt.claim.sub', :'riya', false);
insert into public.items (id, workspace_id, data) values ('item0001', (select ws from ctx), '{"status":"approved","title":"Post","comments":[{"text":"Thanks!"}]}')
  on conflict (id) do update set data = excluded.data;
select 'creator comment saved: ' || (data->'comments'->0->>'text') from public.items where id = 'item0001';
-- ... but can't approve her own new item with an upsert either
insert into public.items (id, workspace_id, data) values ('item0002', (select ws from ctx), '{"status":"in_review"}');
do $$ begin
  insert into public.items (id, workspace_id, data) values ('item0002', (select ws from ctx), '{"status":"approved"}')
    on conflict (id) do update set data = excluded.data;
  raise exception 'FAIL: creator approved via upsert';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: creator cannot approve via upsert'; end $$;
select set_config('request.jwt.claim.sub', :'arjun', false);

-- Arjun promotes Riya to reviewer
select public.set_member_role((select ws from ctx), :'riya', 'reviewer');

-- An outsider sees nothing and can't add items
select set_config('request.jwt.claim.sub', :'out', false);
select 'outsider sees items: ' || count(*) from public.items;
select 'outsider sees workspaces: ' || count(*) from public.workspaces;
do $$ begin
  insert into public.items (id, workspace_id, data) values ('item9999', (select ws from ctx), '{"status":"in_review"}');
  raise exception 'FAIL: outsider inserted';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: outsider blocked'; end $$;
do $$ begin
  perform public.join_workspace('ZZZZZZ', 'x');
  raise exception 'FAIL: bad code accepted';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: wrong code rejected'; end $$;

-- Anonymous visitors (not signed in) see nothing
reset role; set role anon;
do $$ begin
  perform count(*) from public.items;
  raise exception 'FAIL: anon read items';
exception when others then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'ok: anon blocked'; end $$;
reset role;
select 'ALL RLS TESTS PASSED';
