# Katkı / Contributing

## Türkçe

Katkılarınızı memnuniyetle karşılıyoruz.

- **Hata ya da öneri:** Bir issue açın; ne yaptığınızı, ne beklediğinizi ve ne olduğunu, ilgili kayıt satırlarıyla yazın. Kayıtlarda token ya da şifre olmadığından emin olun. Güvenlik açıkları için [SECURITY.md](SECURITY.md).
- **Kod:** Değişiklik büyükse önce bir issue'da konuşalım. Pull request göndermeden önce şunlar temiz olmalı:

  ```powershell
  npm test
  npm run check
  npm run format:check
  npm --prefix desktop test   # desktop/ değiştiyse
  ```

- Botun, panelin ve masaüstü uygulamasının metinleri Türkçedir; kullanıcıya görünen yeni metinleri Türkçe yazın (bot mesajları `src/mesajlar.js` içinde). Kod, kod yorumları ve commit mesajları İngilizce olabilir.
- Masaüstü uygulamasının dayandığı şeyler (`node src/index.js`, konsol satırları, `.env` anahtar adları, `data/durum.json` şeması) `test/contract.test.js` ile sabittir; bunları değiştirirseniz masaüstü uygulamasını da birlikte güncelleyin.
- Katkınız [MIT lisansı](LICENSE) altında yayımlanır.

## English

Contributions are welcome.

- **Bugs and ideas:** open an issue with what you did, what you expected and what happened, plus the relevant log lines (make sure they contain no tokens or passwords). For security issues see [SECURITY.md](SECURITY.md).
- **Code:** for larger changes please discuss in an issue first. Before opening a pull request, run `npm test`, `npm run check`, `npm run format:check` and, if you touched `desktop/`, `npm --prefix desktop test`.
- User-facing text in the bot, the panel and the desktop app is Turkish; please write new user-facing strings in Turkish (bot messages live in `src/mesajlar.js`). Code, comments and commit messages may be in English.
- `test/contract.test.js` pins what the desktop app relies on; change both together.
- Contributions are released under the [MIT License](LICENSE).
