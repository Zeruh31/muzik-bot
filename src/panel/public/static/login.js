const MESSAGES = {
  iptal: 'Giriş iptal edildi.',
  durum: 'Giriş doğrulanamadı (güvenlik kontrolü). Lütfen tekrar deneyin ve paneli her zaman aynı adresten açın.',
  giris: 'Discord ile giriş başarısız oldu. Biraz sonra tekrar deneyin.',
  oturum: 'Oturum açılamadı. Tarayıcınızda çerezlerin açık olduğundan emin olun.',
};

const code = new URLSearchParams(window.location.search).get('hata');
const box = document.getElementById('error');
if (code && box) {
  box.textContent = MESSAGES[code] ?? 'Giriş sırasında bir sorun oluştu.';
  box.classList.remove('hidden');
}
