import { api, el, initHeader, safeUrl, toast } from './common.js';

const list = document.getElementById('guilds');
const notice = document.getElementById('notice');
const refreshButton = document.getElementById('refresh');

function render({ guilds, botReady }) {
  notice.classList.add('hidden');
  if (!botReady) {
    notice.textContent = "Bot henüz Discord'a bağlanmadı; liste birazdan dolacak. Sayfayı yenileyin.";
    notice.classList.remove('hidden');
  }
  if (!guilds.length) {
    list.replaceChildren(
      el(
        'div',
        { class: 'card muted' },
        "Botla ortak bir sunucunuz yok. Botu bir sunucuya eklemek için Discord'da /invite komutunu kullanın.",
      ),
    );
    return;
  }
  list.replaceChildren(
    ...guilds.map((g) => {
      const icon = safeUrl(g.iconUrl);
      return el(
        'a',
        { class: 'guild', href: `/servers/${encodeURIComponent(g.id)}` },
        icon ? el('img', { src: icon, alt: '' }) : el('div', { class: 'icon' }, g.name.slice(0, 1).toUpperCase()),
        el(
          'div',
          { class: 'meta' },
          el('span', { class: 'name' }, g.name),
          el('span', { class: 'np' }, g.nowPlaying ? `▶ ${g.nowPlaying}` : 'Şu an çalmıyor'),
        ),
      );
    }),
  );
}

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  try {
    render(await api('/api/guilds/refresh', { method: 'POST' }));
    toast('Sunucu listesi yenilendi.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
});

try {
  await initHeader();
  render(await api('/api/guilds'));
} catch (error) {
  toast(error.message, true);
}
