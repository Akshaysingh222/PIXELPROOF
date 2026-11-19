-- A tiny stand-in for Supabase's auth system, so schema.sql can be tested on plain Postgres.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
create publication supabase_realtime;
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111', 'arjun@test'),
  ('22222222-2222-2222-2222-222222222222', 'riya@test'),
  ('33333333-3333-3333-3333-333333333333', 'outsider@test');
