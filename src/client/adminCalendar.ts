import { DateTime } from 'luxon';

interface Room {id:string;title:string;email:string}
interface Booking {id:string;room_email:string;room_name:string;starts_at:string;ends_at:string;
  requester_name:string;requester_last_name:string;requester_email:string;state:string;source?:string}
interface Block {id:string;group_id:string;room_email:string;starts_at:string;ends_at:string;label:string;kind:string}
interface External {room_email:string;start:string;end:string}
interface Schedule {start:string;end:string;rooms:Room[];bookings:Booking[];blocks:Block[];external:External[]}
const config=JSON.parse(document.querySelector('#admin-config')?.textContent??'{}') as {csrf:string;rooms:Room[]};
const dateInput=document.querySelector<HTMLInputElement>('#calendar-date')!;
const viewInput=document.querySelector<HTMLSelectElement>('#calendar-view')!;
const roomInput=document.querySelector<HTMLSelectElement>('#calendar-room')!;
const searchInput=document.querySelector<HTMLInputElement>('#booking-search')!;
const stateInput=document.querySelector<HTMLSelectElement>('#booking-state')!;
const grid=document.querySelector<HTMLElement>('#calendar-grid')!;
const feedback=document.querySelector<HTMLElement>('#schedule-feedback')!;
const periodTitle=document.querySelector<HTMLElement>('#period-title')!;
const periodCount=document.querySelector<HTMLElement>('#period-count')!;
const moveDialog=document.querySelector<HTMLDialogElement>('#move-dialog')!;
const moveForm=document.querySelector<HTMLFormElement>('#move-form')!;
let current:Schedule|undefined;
let movingId='';
const local=(iso:string)=>DateTime.fromISO(iso).setZone('Europe/Madrid').setLocale('ca');
const dateToday=()=>DateTime.now().setZone('Europe/Madrid').toISODate()!;
const h=(tag:string,className:string,text:string):HTMLElement=>{
  const node=document.createElement(tag);node.className=className;node.textContent=text;return node;
};
const stamp=(iso:string)=>local(iso).toFormat('HH:mm');

function message(text:string,error=false):void {
  feedback.textContent=text;feedback.classList.toggle('error',error);feedback.hidden=false;
  feedback.scrollIntoView({block:'nearest'});
}
async function request(path:string,body:Record<string,unknown>):Promise<unknown> {
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...body,csrf_token:config.csrf})});
  const result=await response.json() as {error?:string};
  if (!response.ok) throw new Error(result.error??'No s’ha pogut completar l’operació');
  return result;
}
function button(text:string,action:()=>void):HTMLButtonElement {
  const node=document.createElement('button');node.type='button';node.textContent=text;
  node.addEventListener('click',action);return node;
}
function eventCard(kind:'booking'|'block'|'external',title:string,time:string,detail:string):HTMLElement {
  const card=h('div',`calendar-event ${kind}`, '');
  card.append(h('strong','',time),h('div','',title),h('small','',detail));
  return card;
}
function render():void {
  if (!current) return;
  grid.replaceChildren();
  const first=local(current.start).startOf('day');
  const days=viewInput.value==='week'?7:1;
  const selectedRooms=current.rooms.filter(room=>roomInput.value==='all'||room.id===roomInput.value);
  const query=searchInput.value.trim().toLocaleLowerCase('ca');
  const bookingFilter=Boolean(query)||stateInput.value!=='all';
  periodTitle.textContent=days===1?first.toFormat('cccc d LLLL yyyy'):
    `${first.toFormat('d LLL')} – ${first.plus({days:6}).toFormat('d LLL yyyy')}`;
  periodCount.textContent=`${selectedRooms.length} ${selectedRooms.length===1?'aula':'aules'}`;
  for (let index=0;index<days;index++) {
    const day=first.plus({days:index}),dayEnd=day.plus({days:1});
    const section=h('section','calendar-day','');
    section.append(h('h3','',day.toFormat('cccc d LLLL')));
    for (const room of selectedRooms) {
      const bookings=current.bookings.filter(item=>item.room_email.toLowerCase()===room.email.toLowerCase()
        && local(item.starts_at)<dayEnd && local(item.ends_at)>day
        && (stateInput.value==='all'||item.state===stateInput.value)
        && (!query||[item.id,item.requester_name,item.requester_last_name,item.requester_email]
          .some(value=>value.toLocaleLowerCase('ca').includes(query))));
      const blocks=current.blocks.filter(item=>item.room_email.toLowerCase()===room.email.toLowerCase()
        && local(item.starts_at)<dayEnd && local(item.ends_at)>day);
      const external=current.external.filter(item=>item.room_email.toLowerCase()===room.email.toLowerCase()
        && local(item.start)<dayEnd && local(item.end)>day);
      const area=h('div','calendar-room','');area.append(h('h4','',room.title));
      const events:Array<{start:string;node:HTMLElement}>=[];
      for (const item of bookings) {
        const card=eventCard('booking',`${item.requester_name} ${item.requester_last_name}`.trim(),
          `${stamp(item.starts_at)}–${stamp(item.ends_at)}`,
          `${item.state==='cancelled'?'Cancel·lada · ':''}${item.source==='admin'?'Secretaria':'Web'} · ${item.requester_email}`);
        if (item.state==='cancelled') card.classList.add('cancelled');
        if (['confirmed','pending'].includes(item.state)) {
          const actions=h('div','event-actions','');
          if (item.state==='confirmed') actions.append(button('Canvia',()=>openMove(item,room)));
          actions.append(button('Cancel·la',()=>void cancelBooking(item)));
          card.append(actions);
        }
        events.push({start:item.starts_at,node:card});
      }
      for (const item of bookingFilter?[]:blocks) {
        const card=eventCard('block',item.label,`${stamp(item.starts_at)}–${stamp(item.ends_at)}`,
          item.kind==='holiday'?'Vacances o tancament':'Bloqueig');
        const actions=h('div','event-actions','');
        actions.append(button('Lleva el bloqueig',()=>void cancelBlock(item)));
        card.append(actions);events.push({start:item.starts_at,node:card});
      }
      for (const item of bookingFilter?[]:external) events.push({start:item.start,node:eventCard('external','Ocupat en Workspace',
        `${stamp(item.start)}–${stamp(item.end)}`,'Es gestiona des de Google Calendar')});
      events.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
      if (events.length) area.append(...events.map(item=>item.node));
      else area.append(h('p','calendar-empty','Sense ocupació registrada'));
      section.append(area);
    }
    grid.append(section);
  }
}
async function load():Promise<void> {
  grid.replaceChildren(h('p','calendar-empty','Carregant el calendari…'));
  try {
    const response=await fetch(`/admin/api/schedule?date=${encodeURIComponent(dateInput.value)}&view=${viewInput.value}`);
    const data=await response.json() as Schedule & {error?:string};
    if (!response.ok) throw new Error(data.error??'No es pot carregar el calendari');
    current=data;render();
  } catch(error) { grid.replaceChildren(h('p','calendar-empty','No s’ha pogut carregar el calendari.'));
    message(error instanceof Error?error.message:'Error de connexió',true); }
}
async function cancelBooking(item:Booking):Promise<void> {
  if (!window.confirm(`Vols cancel·lar la reserva de ${item.room_name} i avisar la persona?`)) return;
  try { const result=await request(`/admin/api/bookings/${item.id}/cancel`,{}) as {notifications:{failed:number}};
    message(result.notifications.failed?'Reserva cancel·lada, però algun correu no s’ha pogut enviar. Contacta amb la persona.':'Reserva cancel·lada i avisos enviats.',Boolean(result.notifications.failed));await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut cancel·lar',true); }
}
async function cancelBlock(item:Block):Promise<void> {
  if (!window.confirm('Vols llevar este bloqueig i totes les seues repeticions o aules del mateix grup?')) return;
  try { await request(`/admin/api/blocks/${item.group_id}/cancel`,{});message('Bloqueig llevat de Workspace.');await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut llevar',true); }
}
function openMove(item:Booking,room:Room):void {
  movingId=item.id;
  (moveForm.elements.namedItem('room') as HTMLSelectElement).value=room.id;
  (moveForm.elements.namedItem('start') as HTMLInputElement).value=local(item.starts_at).toFormat("yyyy-MM-dd'T'HH:mm");
  (moveForm.elements.namedItem('end') as HTMLInputElement).value=local(item.ends_at).toFormat("yyyy-MM-dd'T'HH:mm");
  moveDialog.showModal();
}
moveForm.addEventListener('submit',async event=>{
  event.preventDefault();
  const data=new FormData(moveForm);
  try { const result=await request(`/admin/api/bookings/${movingId}/move`,{
    room:data.get('room'),start:data.get('start'),end:data.get('end'),
  }) as {notifications:{failed:number}};moveDialog.close();
    message(result.notifications.failed?'Reserva canviada, però algun correu no s’ha pogut enviar. Contacta amb la persona.':'Reserva canviada i avisos enviats.',Boolean(result.notifications.failed));await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut canviar',true); }
});
document.querySelector('#move-close')?.addEventListener('click',()=>moveDialog.close());

for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-toggle-form]')) {
  toggle.addEventListener('click',()=>{
    const target=document.getElementById(toggle.dataset.toggleForm??'');
    if (!target) return;
    for (const form of document.querySelectorAll<HTMLElement>('.operation-form'))
      form.hidden=form!==target || !target.hidden;
    if (target && !target.hidden) target.scrollIntoView({block:'nearest'});
  });
}
for (const all of document.querySelectorAll<HTMLInputElement>('[data-all-rooms]')) {
  all.addEventListener('change',()=>all.closest('fieldset')?.querySelectorAll<HTMLInputElement>('input[name="rooms"]')
    .forEach(input=>{input.checked=all.checked;}));
}
const selectedRooms=(form:HTMLFormElement)=>Array.from(form.querySelectorAll<HTMLInputElement>('input[name="rooms"]:checked'))
  .map(input=>input.value);
document.querySelector<HTMLFormElement>('#block-form')?.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget as HTMLFormElement,data=new FormData(form);
  try { const result=await request('/admin/api/blocks',{
    rooms:selectedRooms(form),start:data.get('start'),end:data.get('end'),label:data.get('label'),
    kind:'block',repeat:data.get('repeat'),until:data.get('until'),
  }) as {count:number};message(`${result.count} bloqueig${result.count===1?'':'s'} creat${result.count===1?'':'s'}.`);
    form.reset();form.hidden=true;await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut crear',true); }
});
document.querySelector<HTMLFormElement>('#holiday-form')?.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget as HTMLFormElement,data=new FormData(form);
  const first=String(data.get('first')),last=DateTime.fromISO(String(data.get('last')),{zone:'Europe/Madrid'});
  try { if (!last.isValid || last.toISODate()!<first) throw new Error('El final ha de ser igual o posterior al primer dia');
    const result=await request('/admin/api/blocks',{
      rooms:selectedRooms(form),start:`${first}T00:00`,end:`${last.plus({days:1}).toISODate()}T00:00`,
      label:data.get('label'),kind:'holiday',repeat:'none',
    }) as {count:number};message(`${result.count} ${result.count===1?'aula tancada':'aules tancades'}.`);
    form.reset();form.hidden=true;await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut tancar',true); }
});
document.querySelector<HTMLFormElement>('#manual-form')?.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget as HTMLFormElement,data=new FormData(form);
  try { const result=await request('/admin/api/bookings',Object.fromEntries(data.entries())) as {state:string};
    message(`Reserva creada. Estat: ${result.state}.`);form.reset();form.hidden=true;await load(); }
  catch(error) { message(error instanceof Error?error.message:'No s’ha pogut reservar',true); }
});
dateInput.value=dateToday();
for (const key of ['calendar-date','calendar-view']) document.getElementById(key)?.addEventListener('change',()=>void load());
roomInput.addEventListener('change',render);
searchInput.addEventListener('input',render);
stateInput.addEventListener('change',render);
document.querySelector('#today-date')?.addEventListener('click',()=>{dateInput.value=dateToday();void load();});
for (const [key,sign] of [['previous-date',-1],['next-date',1]] as const)
  document.getElementById(key)?.addEventListener('click',()=>{
    dateInput.value=DateTime.fromISO(dateInput.value,{zone:'Europe/Madrid'})
      .plus({days:sign*(viewInput.value==='week'?7:1)}).toISODate()!;void load();
  });
void load();
