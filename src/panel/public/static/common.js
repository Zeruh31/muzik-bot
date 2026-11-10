// Shared browser helpers. All user-controlled text is inserted with textContent, never innerHTML.

let csrfToken = null;

/** Creates an element: el('a', { href: '/x', class: 'y' }, 'text', otherNode). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Only http(s) links are ever put into href/src. */
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

let toastTimer;
export function toast(message, isError = false) {
  let box = document.querySelector('.toast');
  if (!box) {
    box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = message;
  box.classList.toggle('error', isError);
  box.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), 4000);
}

/** JSON API call. Mutations carry the CSRF token. Throws Error(message) on failure. */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken ?? '';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    window.location.href = '/';
    throw new Error('Oturum kapandı.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `İstek başarısız (${response.status}).`);
  return data;
}

/** Loads the current user, fills the header and wires the logout button. */
export async function initHeader() {
  const me = await api('/api/me');
  csrfToken = me.csrfToken;
  const box = document.getElementById('user');
  if (box) {
    box.replaceChildren(
      me.user.avatarUrl
        ? el('img', { class: 'avatar', src: me.user.avatarUrl, alt: '' })
        : el('div', { class: 'avatar' }),
      el('span', {}, me.user.globalName ?? me.user.username),
      el(
        'button',
        {
          class: 'small',
          type: 'button',
          onclick: async () => {
            try {
              await api('/auth/logout', { method: 'POST' });
            } finally {
              window.location.href = '/';
            }
          },
        },
        'Çıkış',
      ),
    );
  }
  return me;
}
