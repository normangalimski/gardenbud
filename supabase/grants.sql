-- GardenBud: table permissions for signed-in (anonymous) users.
-- Safe to run more than once. Row-level security still decides which rows each person can see or change.
grant usage on schema public to authenticated;
grant select, update on public.members to authenticated;
grant select on public.member_devices to authenticated;
grant select, insert, update, delete on public.designs to authenticated;
grant select on public.design_versions to authenticated;
grant select, insert, update, delete on public.comments to authenticated;
grant select, insert, update, delete on public.comment_reads to authenticated;
select 'GardenBud permissions are set' as done;
