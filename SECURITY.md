# Güvenlik / Security

## Güvenlik açığı bildirmek

Bir güvenlik açığı bulduysanız lütfen **herkese açık bir issue açmayın**. Bunun yerine GitHub'ın özel bildirim özelliğini kullanın:

1. Depo sayfasında **Security** sekmesine gidin.
2. **Report a vulnerability** düğmesine basın ve açığı, nasıl tekrarlanacağını ve etkisini yazın.

Bildirimler yalnız depo yöneticileri tarafından görülür. Mümkün olan en kısa sürede yanıt verilir; düzeltme yayımlanana kadar ayrıntıları paylaşmamanızı rica ederiz.

Bildirime **token, şifre ya da `.env` içeriği eklemeyin**. Bir token yanlışlıkla paylaşıldıysa hemen yenileyin (Discord Developer Portal > Bot > Reset Token).

Kapsam: bot (`src/`), web paneli (`src/panel/`), masaüstü uygulaması (`desktop/`) ve yardımcı betikler. Lavalink, eklentileri ve diğer bağımlılıklardaki açıkları ilgili projelere bildirin.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**, then describe the issue, how to reproduce it and its impact. Only the maintainers can see the report.

**Never include tokens, passwords or `.env` contents.** If a token leaked, reset it right away (Discord Developer Portal > Bot > Reset Token).

Scope: the bot (`src/`), the web panel (`src/panel/`), the desktop app (`desktop/`) and the helper scripts. Report issues in Lavalink, its plugins or other dependencies to those projects.
