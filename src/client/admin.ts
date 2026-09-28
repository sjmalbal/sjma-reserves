const search = document.querySelector<HTMLInputElement>('#resource-search');
const filter = document.querySelector<HTMLSelectElement>('#resource-filter');
const count = document.querySelector<HTMLElement>('#resource-count');
const empty = document.querySelector<HTMLElement>('#resource-empty');
const resources = Array.from(document.querySelectorAll<HTMLElement>('.resource'));

function updateResources(): void {
  if (!search || !filter || !count || !empty) return;
  const query = search.value.trim().toLocaleLowerCase('ca');
  let visible = 0;
  for (const resource of resources) {
    const matchesText = !query || (resource.dataset.search ?? '').toLocaleLowerCase('ca').includes(query);
    const matchesStatus = filter.value === 'all'
      || (filter.value === 'published' && resource.dataset.published === 'true')
      || (filter.value === 'hidden' && resource.dataset.published === 'false');
    resource.hidden = !(matchesText && matchesStatus);
    if (!resource.hidden) visible += 1;
  }
  count.textContent = `${visible} ${visible === 1 ? 'recurs' : 'recursos'}`;
  empty.hidden = visible !== 0;
}

search?.addEventListener('input', updateResources);
filter?.addEventListener('change', updateResources);
updateResources();

if (location.hash.startsWith('#resource-')) {
  const resource = document.querySelector<HTMLElement>(location.hash);
  if (resource?.classList.contains('resource')) {
    const details = resource.querySelector<HTMLDetailsElement>('.resource-details');
    if (details) details.open = true;
    requestAnimationFrame(() => resource.scrollIntoView({block:'start'}));
  }
}

const viewer = document.querySelector<HTMLDialogElement>('#photo-viewer');
const viewerImage = viewer?.querySelector<HTMLImageElement>('img');
const viewerCaption = viewer?.querySelector<HTMLElement>('p');
viewer?.querySelector<HTMLButtonElement>('.viewer-close')?.addEventListener('click', () => viewer.close());
viewer?.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });

function updateCoverLabels(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLInputElement>('input[name="cover_photo"]').forEach(input => {
    const label = input.closest<HTMLElement>('.cover-choice')?.querySelector<HTMLElement>('span');
    if (label) label.textContent = input.checked ? 'Portada seleccionada' : 'Fes-la portada';
  });
}

for (const resource of resources) {
  const form = resource.querySelector<HTMLFormElement>('form');
  if (!form) continue;
  const upload = form.querySelector<HTMLInputElement>('input[type="file"][name="photos"]');
  upload?.addEventListener('change', () => {
    const status = form.querySelector<HTMLElement>('.upload-selection');
    const length = upload.files?.length ?? 0;
    if (status) status.textContent = length
      ? `${length} ${length === 1 ? 'foto seleccionada' : 'fotos seleccionades'}. Guarda els canvis per a afegir-les.`
      : '';
    upload.setCustomValidity(length > 4 ? 'Puja com a màxim quatre fotos cada vegada' : '');
  });
  form.addEventListener('change', event => {
    if ((event.target as HTMLInputElement).name === 'cover_photo') updateCoverLabels(form);
  });
  form.querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(button => button.addEventListener('click', () => {
    if (!viewer || !viewerImage || !viewerCaption) return;
    viewerImage.src = button.dataset.preview ?? '';
    viewerImage.alt = button.getAttribute('aria-label') ?? 'Fotografia de l’espai';
    viewerCaption.textContent = resource.querySelector<HTMLElement>('.resource-title')?.textContent ?? '';
    viewer.showModal();
  }));
  form.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(button => button.addEventListener('click', async () => {
    const photo = button.dataset.delete;
    const key = resource.id.replace(/^resource-/, '');
    const csrf = form.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value;
    if (!photo || !csrf || !window.confirm('Vols llevar esta foto de la fitxa pública?')) return;
    button.disabled = true;
    try {
      const response = await fetch(`/admin/resources/${encodeURIComponent(key)}/photos/remove`, {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({photo,csrf_token:csrf}),
      });
      const data = await response.json() as {photos?: string[];error?: string};
      if (!response.ok || !data.photos) throw new Error(data.error ?? 'No s’ha pogut llevar la foto');
      button.closest('.photo')?.remove();
      const cards = Array.from(form.querySelectorAll<HTMLElement>('.photo'));
      const empty = form.querySelector<HTMLElement>('.photos .empty');
      if (!cards.length) {
        const message = document.createElement('p');message.className = 'empty';message.textContent = 'Encara no hi ha fotos.';
        form.querySelector('.photos')?.append(message);
      } else if (empty) empty.remove();
      const cover = form.querySelector<HTMLInputElement>('input[name="cover_photo"]:checked');
      if (!cover && cards.length) {
        const first = cards[0].querySelector<HTMLInputElement>('input[name="cover_photo"]');
        if (first) first.checked = true;
      }
      updateCoverLabels(form);
      const preview = resource.querySelector<HTMLElement>('.resource-preview');
      if (preview) {
        preview.replaceChildren();
        if (data.photos.length) {
          const img = document.createElement('img');img.src = data.photos[0];img.alt = '';
          preview.append(img);
        } else {
          const placeholder = document.createElement('span');placeholder.className = 'resource-placeholder';
          placeholder.setAttribute('aria-hidden','true');placeholder.textContent = '▥';preview.append(placeholder);
        }
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'No s’ha pogut llevar la foto');
      button.disabled = false;
    }
  }));
}
