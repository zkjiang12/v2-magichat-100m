-- day_in_life_us is the email-gated, US-routed variant of day_in_life_creators,
-- feeding cold-email outbound via Instantly (like ugc_creators_email / 017).

insert into campaigns (name, message_template)
select 'day_in_life_us', message_template
from campaigns
where name = 'day_in_life_creators'
on conflict (name) do nothing;

-- In case the day_in_life_creators row is missing in this environment.
insert into campaigns (name)
values ('day_in_life_us')
on conflict (name) do nothing;
