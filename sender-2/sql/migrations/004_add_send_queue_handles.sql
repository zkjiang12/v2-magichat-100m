alter table send_queue
  add column if not exists recipient_handle text,
  add column if not exists sender_handle text;

update send_queue sq
set recipient_handle = c.handle
from creators c
where sq.creator_id = c.id
  and sq.recipient_handle is null;

update send_queue sq
set sender_handle = case sa.username
  when 'account-1' then 'zikang_jiang'
  when 'account-2' then 'try_magic_hat'
  when 'account-3' then 'bhavanipratap.patil'
  when 'account-4' then 'madhav_rapelli'
  else sa.username
end
from sender_accounts sa
where sq.sender_account_id = sa.id
  and sq.sender_handle is null;

create index if not exists send_queue_recipient_handle_idx
  on send_queue (recipient_handle);

create index if not exists send_queue_sender_handle_idx
  on send_queue (sender_handle);
