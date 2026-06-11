-- 016 is reserved by the dashboard-perf branch (not yet merged here), so this is 017.
-- ugc_creators_email is a clone of ugc_creators that only accepts creators with a
-- contactable email, feeding a pure cold-email outbound flow via Instantly.

insert into campaigns (name, message_template)
select 'ugc_creators_email', message_template
from campaigns
where name = 'ugc_creators'
on conflict (name) do nothing;

-- In case the ugc_creators row is missing in this environment.
insert into campaigns (name)
values ('ugc_creators_email')
on conflict (name) do nothing;
