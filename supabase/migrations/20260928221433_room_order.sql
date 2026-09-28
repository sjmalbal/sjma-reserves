-- Add a public display order without changing existing room identities or bookings.
alter table public.sjma_reservas_rooms add column if not exists sort_order integer;

with ranked as (
  select resource_email, (row_number() over (order by room_id) * 10)::integer as position
  from public.sjma_reservas_rooms
)
update public.sjma_reservas_rooms as room
set sort_order = ranked.position
from ranked
where room.resource_email = ranked.resource_email and room.sort_order is null;

alter table public.sjma_reservas_rooms alter column sort_order set default 1000;
alter table public.sjma_reservas_rooms alter column sort_order set not null;
alter table public.sjma_reservas_rooms
  add constraint sjma_reservas_rooms_sort_order_range check (sort_order between 1 and 9999);
