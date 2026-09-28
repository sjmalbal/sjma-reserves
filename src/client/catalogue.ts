interface Room { id: string; name: string; title: string; features: string[]; photos: string[]; address?: string }
interface Interval { start: string; end: string }
interface DayEnd { value: string; label: string; time: string; minutes: number }
interface DayStart { value: string; label: string; time: string; ends: DayEnd[] }
interface RoomDay { busy: Interval[]; starts: DayStart[] }
interface DayData { date: string; opening_at: string; closing_at: string; step_minutes: number; rooms: Record<string, RoomDay> }
interface BookingStatus { state: 'confirmed' | 'pending' | 'declined' | 'failed'; notifications?: { requester?: string }; error?: string; id?: string }
declare global { interface Window { SJMA_ROOMS?: Room[]; SJMA_MAX_DAYS?: number } }
const rooms: Room[] = window.SJMA_ROOMS || [];
const roomById = new Map(rooms.map(room => [room.id, room]));
const featureIcons: Record<string,string>={'Piano':'piano','Espill':'mirror','Pissarra Digital':'digital-board','Pissarra':'board','Micròfon de gravació':'microphone','Altaveus':'speakers','Projector':'projector'};
const savedDetailsKey='sjma-booking-details';
const selectedFeatures = new Set<string>();
const dayCache = new Map<string,{at:number;promise:Promise<DayData>}>();
const today = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
const lastDay = new Date(Date.parse(today + 'T12:00:00Z') + (window.SJMA_MAX_DAYS ?? 90) * 86400000).toISOString().slice(0,10);
type FormNode = HTMLElement & HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
const $ = (selector: string): FormNode => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Falta l'element ${selector}`);
  return element as FormNode;
};
let currentView = 'grid';
let currentRoom: Room | null = null;
let currentDay: RoomDay | null = null;
let filterTicket = 0;
let statusTimer: ReturnType<typeof setInterval> | null = null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

for (const selector of ['#filter-date','#booking-date']) {
  const input = $(selector);
  input.min = today; input.max = lastDay;
}
$('#booking-date').value = today;

function formatDate(value: string) { return value ? value.split('-').reverse().join('/') : ''; }
function durationText(minutes: number) { return `${Math.floor(minutes/60)} h ${String(minutes%60).padStart(2,'0')} min`; }
function intervalsOverlap(start: string, end: string, intervals: Interval[]) {
  const a = Date.parse(start), b = Date.parse(end);
  return intervals.some(interval => a < Date.parse(interval.end) && Date.parse(interval.start) < b);
}
function showNotice(message: string) { const box=$('#catalogue-message'); box.textContent=message; box.hidden=!message; }

async function fetchDay(day: string, fresh=false): Promise<DayData> {
  const cached=dayCache.get(day);
  if (!fresh && cached && Date.now()-cached.at < 30000) return cached.promise;
  const promise=fetch(`/api/day?date=${encodeURIComponent(day)}`).then(async response => {
    const data=await response.json() as DayData & {error?: string};
    if (!response.ok) throw new Error(data.error || 'No podem consultar la disponibilitat ara.');
    return data;
  });
  dayCache.set(day,{at:Date.now(),promise});
  promise.catch(()=>dayCache.delete(day));
  return promise;
}

function featureToggle(feature: string) {
  if (selectedFeatures.has(feature)) selectedFeatures.delete(feature);
  else selectedFeatures.add(feature);
  document.querySelectorAll<HTMLButtonElement>('.feature-filter').forEach(button =>
    button.setAttribute('aria-pressed', String(selectedFeatures.has(button.dataset.feature ?? ''))));
  updateCatalogue();
}
document.querySelectorAll<HTMLButtonElement>('.feature-filter').forEach(button =>
  button.addEventListener('click', () => featureToggle(button.dataset.feature ?? '')));
$('#reset-filters').addEventListener('click', () => {
  selectedFeatures.clear();
  document.querySelectorAll<HTMLButtonElement>('.feature-filter').forEach(button => button.setAttribute('aria-pressed','false'));
  $('#filter-search').value=''; $('#filter-date').value=''; $('#filter-duration').value='';
  $('#filter-from').value=''; $('#filter-until').value='';
  (document.querySelector('.more-filters') as HTMLDetailsElement).open=false;
  updateCatalogue();
});

for (const selector of ['#filter-search','#filter-date','#filter-duration','#filter-from','#filter-until']) {
  $(selector).addEventListener(selector==='#filter-search'?'input':'change', updateCatalogue);
}

function matchesTextAndFeatures(room: Room) {
  const query=$('#filter-search').value.trim().toLocaleLowerCase();
  const haystack=(room.title+' '+room.features.join(' ')).toLocaleLowerCase();
  return (!query || haystack.includes(query)) && [...selectedFeatures].every(feature=>room.features.includes(feature));
}

async function updateCatalogue() {
  const ticket=++filterTicket;
  const date=$('#filter-date').value;
  const duration=Number($('#filter-duration').value);
  const from=$('#filter-from').value, until=$('#filter-until').value;
  let dayData: DayData | null=null;
  showNotice('');
  if ((duration || from || until) && !date) showNotice('Selecciona una data per filtrar per duració o horari.');
  if (from && until && from>=until) { showNotice('L’hora final ha de ser posterior a la inicial.'); return; }
  if (date) {
    try { dayData=await fetchDay(date); }
    catch (error) {
      if (ticket===filterTicket) {
        showNotice(errorMessage(error)+' Torna-ho a provar canviant la data.');
        document.querySelectorAll<HTMLElement>('.room-card').forEach(card=>card.hidden=true);
        $('#result-count').textContent='0 espais';
        renderMapList([]);
        if(currentView==='calendar')renderCalendar([],null);
      }
      return;
    }
  }
  if (ticket!==filterTicket) return;
  const visible=rooms.filter(room => {
    if (!matchesTextAndFeatures(room)) return false;
    if (!dayData) return true;
    const starts=dayData.rooms[room.id]?.starts || [];
    return starts.some(start => start.ends.some(end => {
      if (duration && end.minutes!==duration) return false;
      if (from && until) return start.time===from && end.time===until;
      if (from && start.time<from) return false;
      if (until && end.time>until) return false;
      return true;
    }));
  });
  const ids=new Set(visible.map(room=>room.id));
  document.querySelectorAll<HTMLElement>('.room-card').forEach(card => card.hidden=!ids.has(card.dataset.roomId ?? ''));
  $('#result-count').textContent=`${visible.length} ${visible.length===1?'espai':'espais'}`;
  renderMapList(visible);
  if (currentView==='calendar') renderCalendar(visible, dayData);
  if (!visible.length && !$('#catalogue-message').textContent) showNotice('No hi ha espais amb estos filtres.');
}

function renderMapList(visible: Room[]) {
  const container=$('#map-room-list'); container.replaceChildren();
  visible.forEach(room => {
    const button=document.createElement('button'); button.type='button';
    button.textContent=room.title+' ↗'; button.addEventListener('click',()=>openRoom(room.id));
    container.append(button);
  });
}

function renderCalendar(visible: Room[], dayData: DayData | null) {
  const container=$('#calendar-content'); container.replaceChildren();
  if (!dayData) { container.textContent='Selecciona una data per veure el calendari.'; return; }
  const hours=document.createElement('div'); hours.className='calendar-hours';
  const spacer=document.createElement('span'); hours.append(spacer);
  const day=dayData.date;
  const firstTime=Date.parse(dayData.opening_at);
  const lastTime=Date.parse(dayData.closing_at);
  const stepMilliseconds=dayData.step_minutes*60000;
  const cellCount=Math.round((lastTime-firstTime)/stepMilliseconds);
  const hourLabel=new Intl.DateTimeFormat('ca-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const offsetLabel=new Intl.DateTimeFormat('en',{timeZone:'Europe/Madrid',timeZoneName:'shortOffset'});
  for(let time=firstTime;time<lastTime;time+=3*3600000){
    const label=document.createElement('span');
    const local=hourLabel.format(new Date(time));
    const repeated=time>=firstTime+3600000 && hourLabel.format(new Date(time-3600000))===local;
    label.textContent=repeated?`${local} (${offsetLabel.formatToParts(new Date(time)).find(part=>part.type==='timeZoneName')?.value ?? ''})`:local;
    hours.append(label);
  }
  const endLabel=document.createElement('span');
  endLabel.textContent=hourLabel.format(new Date(lastTime))==='00:00'?'24:00':hourLabel.format(new Date(lastTime));
  hours.append(endLabel);
  container.append(hours);
  visible.forEach(room => {
    const row=document.createElement('div');row.className='calendar-row';
    const label=document.createElement('button');label.type='button';label.textContent=room.title;
    label.addEventListener('click',()=>openRoom(room.id));row.append(label);
    const track=document.createElement('div');track.className='calendar-track';
    const busy=dayData.rooms[room.id]?.busy||[];
    const validStarts=new Map((dayData.rooms[room.id]?.starts||[]).map(item=>[Date.parse(item.value),item.value]));
    track.style.gridTemplateColumns=`repeat(${cellCount}, minmax(0, 1fr))`;
    for(let index=0;index<cellCount;index++) {
      const fromTime=firstTime+index*stepMilliseconds;
      const from=new Date(fromTime).toISOString();
      const to=new Date(fromTime+stepMilliseconds).toISOString();
      const cell=document.createElement('span');
      const candidate=validStarts.get(fromTime);
      const occupied=intervalsOverlap(from,to,busy);
      cell.className=occupied?'occupied':(candidate?'free':'unavailable');
      if(candidate) {cell.title=room.title+' · '+hourLabel.format(new Date(fromTime));cell.tabIndex=0;cell.setAttribute('role','button');cell.addEventListener('click',()=>openRoom(room.id,day,candidate));cell.addEventListener('keydown',event=>{if(event.key==='Enter')openRoom(room.id,day,candidate)})}
      track.append(cell);
    }
    row.append(track);container.append(row);
  });
}

function renderGallery(room: Room, index=0) {
  const image=$('#detail-photo'), thumbnails=$('#detail-thumbnails');
  image.replaceChildren(); thumbnails.replaceChildren();
  if (!room.photos.length) {image.textContent='Fotografia pendent';return}
  const photo=document.createElement('img');photo.src=room.photos[index];photo.alt=`Fotografia ${index+1} de ${room.title}`;
  image.append(photo);
  if(room.photos.length>1) {
    for(const [direction,symbol,label] of [[-1,'‹','Fotografia anterior'],[1,'›','Fotografia següent']] as Array<[number,string,string]>){
      const button=document.createElement('button');button.type='button';button.className=direction<0?'gallery-previous':'gallery-next';
      button.textContent=symbol;button.setAttribute('aria-label',label);
      button.addEventListener('click',()=>renderGallery(room,(index+direction+room.photos.length)%room.photos.length));
      image.append(button);
    }
    room.photos.forEach((source,number)=>{
      const button=document.createElement('button');button.type='button';button.className='gallery-thumb';
      button.setAttribute('aria-label',`Mostra la fotografia ${number+1}`);
      button.setAttribute('aria-pressed',String(number===index));
      const thumb=document.createElement('img');thumb.src=source;thumb.alt='';button.append(thumb);
      button.addEventListener('click',()=>renderGallery(room,number));thumbnails.append(button);
    });
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
  currentView=button.dataset.view ?? 'grid';
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  $('#room-grid').hidden=currentView!=='grid';
  $('#map-view').hidden=currentView!=='map';
  $('#calendar-view').hidden=currentView!=='calendar';
  if (currentView==='calendar' && !$('#filter-date').value) $('#filter-date').value=today;
  updateCatalogue();
}));

function roomPath(id: string): string { return `/aules/${encodeURIComponent(id)}`; }

async function openRoom(id: string, date: string | null=null, preferredStart: string | null=null, navigate=true) {
  const room=roomById.get(id); if(!room) return;
  if (statusTimer) { clearInterval(statusTimer); statusTimer=null; }
  if (navigate) history.pushState({fromCatalogue:true}, '', roomPath(id));
  currentRoom=room;
  $('#catalogue-section').hidden=true; $('.organization').hidden=true; $('#room-detail').hidden=false;
  $('#detail-title').textContent=room.title;
  const featureList=$('#detail-features');featureList.replaceChildren();
  if (!room.features.length) featureList.textContent='Sala d’assaig';
  room.features.forEach(feature=>{
    const item=document.createElement('span');item.className='room-feature';
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.classList.add('feature-icon');icon.setAttribute('aria-hidden','true');
    const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href',`#icon-${featureIcons[feature]}`);icon.append(use);
    item.append(icon,document.createTextNode(feature));featureList.append(item);
  });
  renderGallery(room);
  $('#booking-date').value=date||$('#filter-date').value||today;
  $('#booking-result').hidden=true;
  $('#booking-note').value='';
  document.title=`${room.title} · Reserva d'espais SJMA`;
  window.scrollTo({top:0,behavior:navigate?'smooth':'auto'});
  await loadRoomTimes(preferredStart);
}

function showCatalogue(): void {
  if (statusTimer) { clearInterval(statusTimer); statusTimer=null; }
  $('#room-detail').hidden=true;$('#catalogue-section').hidden=false;$('.organization').hidden=false;
  currentRoom=null;currentDay=null;
  document.title="Reserva d'espais · Societat Joventut Musical d'Albal";
  window.scrollTo({top:0,behavior:'auto'});
  updateCatalogue();
}

function renderRoute(): void {
  const parts=location.pathname.split('/').filter(Boolean);
  if (parts[0]==='aules' && parts[1] && roomById.has(parts[1])) {
    const ref=parts[2]==='reserves' && /^[a-f0-9]{32}$/.test(parts[3] ?? '') ? parts[3] : null;
    void openRoom(parts[1],null,null,false).then(()=>{
      if (ref) { void checkStatus(ref);statusTimer=setInterval(()=>checkStatus(ref),5000); }
    });
  } else showCatalogue();
}

async function loadRoomTimes(preferredStart: string | null=null) {
  if (!currentRoom) return;
  const selectedRoom=currentRoom.id, day=$('#booking-date').value;
  $('#time-feedback').textContent='Consultant la disponibilitat…';
  $('#booking-start').replaceChildren(new Option('Selecciona una hora',''));
  $('#booking-end').replaceChildren(new Option('Selecciona una hora',''));
  try {
    const data=await fetchDay(day,true);
    if(!currentRoom||currentRoom.id!==selectedRoom||$('#booking-date').value!==day)return;
    currentDay=data.rooms[selectedRoom];
    currentDay.starts.forEach(start=>$('#booking-start').add(new Option(start.label,start.value)));
    if(currentDay.starts.length) {
      $('#booking-start').value=preferredStart&&currentDay.starts.some(item=>item.value===preferredStart)?preferredStart:currentDay.starts[0].value;
      updateEndTimes(); $('#time-feedback').textContent='Tria una hora de començament i una de finalització.';
    } else $('#time-feedback').textContent='No hi ha horaris lliures per a esta data.';
  } catch(error) {$('#time-feedback').textContent=errorMessage(error)+' Torna-ho a provar canviant la data.';}
}

function updateEndTimes() {
  const starts=currentDay?.starts||[];
  const selected=starts.find(item=>item.value===$('#booking-start').value);
  $('#booking-end').replaceChildren(new Option('Selecciona una hora',''));
  if (!selected) return;
  selected.ends.forEach(end=>$('#booking-end').add(new Option(`${end.label} · ${durationText(end.minutes)}`,end.value)));
  $('#booking-end').value=selected.ends[0]?.value||'';
}

$('#booking-date').addEventListener('change',()=>loadRoomTimes());
$('#booking-start').addEventListener('change',updateEndTimes);
$('#back-to-catalogue').addEventListener('click',()=>{
  if (history.state?.fromCatalogue) history.back();
  else { history.pushState(null,'','/');showCatalogue(); }
});
window.addEventListener('popstate', renderRoute);
document.querySelectorAll<HTMLButtonElement>('[data-open-room]').forEach(button=>button.addEventListener('click',()=>openRoom(button.dataset.openRoom ?? '')));

async function checkStatus(id: string) {
  try {
    const response=await fetch(`/api/bookings/${id}`), data=await response.json() as BookingStatus;
    if(!response.ok)throw new Error(data.error);
    const messages: Record<BookingStatus['state'],string>={confirmed:'Reserva confirmada. L’aula ha acceptat el torn.',pending:'Sol·licitud pendent. Esperant la resposta de l’aula.',declined:'Reserva no confirmada. L’aula ha rebutjat el torn.',failed:'Reserva no confirmada. No s’ha pogut crear l’esdeveniment.'};
    let notice=messages[data.state];
    if(data.state==='confirmed' && data.notifications?.requester==='sent') notice+=' T’hem enviat els detalls per correu.';
    if(data.state==='confirmed' && data.notifications?.requester!=='sent') notice+=' No hem pogut confirmar l’enviament del correu; guarda la referència i contacta amb secretaria.';
    const box=$('#booking-result');box.hidden=false;box.textContent=`${notice} Referència: ${id}`;
    if(data.state!=='pending' && statusTimer)clearInterval(statusTimer);
  }catch(error){$('#booking-result').textContent=errorMessage(error);if(statusTimer)clearInterval(statusTimer)}
}

$('#booking-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!currentRoom||!$('#booking-start').value||!$('#booking-end').value){$('#time-feedback').textContent='Selecciona l’hora de començament i de finalització.';return}
  const button=$('#submit-booking');button.disabled=true;
  const box=$('#booking-result');box.hidden=false;box.textContent='Comprovant la reserva…';
  try {
    const response=await fetch('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom.id,start:$('#booking-start').value,end:$('#booking-end').value,name:$('#booking-name').value,last_name:$('#booking-last-name').value,email:$('#booking-email').value,instrument:$('#booking-instrument').value,relation:$('#booking-relation').value,note:$('#booking-note').value,privacy_accepted:$('#booking-privacy').checked})});
    const data=await response.json() as BookingStatus;if(!response.ok)throw new Error(data.error||'No s’ha pogut crear la reserva.');
    try {
      if($('#booking-remember').checked) localStorage.setItem(savedDetailsKey,JSON.stringify({name:$('#booking-name').value,last_name:$('#booking-last-name').value,email:$('#booking-email').value,instrument:$('#booking-instrument').value,relation:$('#booking-relation').value}));
      else localStorage.removeItem(savedDetailsKey);
    } catch { /* La reserva funciona encara que el navegador no permeta emmagatzemar dades. */ }
    if (data.id) history.replaceState(history.state,'',`${roomPath(currentRoom.id)}/reserves/${data.id}`);
    await checkStatus(data.id ?? '');
    if(data.state==='pending')statusTimer=setInterval(()=>checkStatus(data.id ?? ''),5000);
    dayCache.delete($('#booking-date').value);
  }catch(error){box.textContent=errorMessage(error)}
  finally{button.disabled=false}
});
$('#booking-remember').addEventListener('change',()=>{
  if(!$('#booking-remember').checked) { try { localStorage.removeItem(savedDetailsKey); } catch {} }
});

try {
  const saved=JSON.parse(localStorage.getItem(savedDetailsKey)||'null');
  if(saved && typeof saved==='object') {
    for(const [field,selector] of Object.entries({name:'#booking-name',last_name:'#booking-last-name',email:'#booking-email',instrument:'#booking-instrument',relation:'#booking-relation'})) {
      if(typeof saved[field]==='string') $(selector).value=saved[field];
    }
    $('#booking-remember').checked=true;
  }
} catch { localStorage.removeItem(savedDetailsKey); }
const legacyParams=new URLSearchParams(location.search);
const legacyRoom=legacyParams.get('room');
if(location.pathname==='/' && legacyRoom && roomById.has(legacyRoom)) {
  const ref=legacyParams.get('ref');
  history.replaceState(history.state,'',ref&&/^[a-f0-9]{32}$/.test(ref)
    ? `${roomPath(legacyRoom)}/reserves/${ref}` : roomPath(legacyRoom));
}
renderRoute();
