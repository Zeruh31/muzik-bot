# Müzik Bot

**Türkçe** · [English](README.en.md)

Discord için açık kaynak müzik botu. YouTube'dan (ve isteğe bağlı olarak Spotify bağlantılarından) müzik çalar, yalnız eğik çizgi (`/`) komutlarıyla çalışır. Botu kendi bilgisayarınızda çalıştırırsınız; isterseniz tarayıcıdan yönetilen bir web paneli ve konsol pencereleri açmadan her şeyi yöneten bir Windows masaüstü uygulaması da var. Botun, panelin ve uygulamanın arayüzü Türkçedir.

- **discord.js 14.28.1** (Node.js 24)
- **@discordjs/voice 0.19.2** + **@snazzah/davey** (Discord'un 2 Mart 2026'dan beri zorunlu tuttuğu DAVE uçtan uca şifreli ses): sesi Discord'a botun kendisi gönderir
- **@discordjs/opus 0.11.0** (Opus kodlama) ve **ffmpeg** (sistemdeki; yoksa `ffmpeg-static`)
- **Lavalink 4.2.2** (REST): arama, bağlantı çözme, YouTube ses akışı ve şarkı sözleri; ses kanalına kendisi bağlanmaz (bkz. Teknik notlar)
- Lavalink eklentileri: **youtube-plugin (master snapshot `2be8e54`, bkz. Teknik notlar)**, **LavaSrc 4.8.3** (Spotify), **LavaLyrics 1.1.0** (şarkı sözleri)

> **Discord erişimi:** Ülkenizde ya da ağınızda Discord'a erişim engelliyse bot da bağlanamaz. Bu durumda bot çalışırken kullandığınız erişim aracının (VPN, DPI atlatma aracı vb.) açık olması gerekir.

| Ana ekran | Sunucular | İstatistikler |
|---|---|---|
| ![Masaüstü uygulaması ana ekran](docs/ekran-ana.png) | ![Sunucular sekmesi](docs/ekran-sunucular.png) | ![İstatistikler sekmesi](docs/ekran-istatistik.png) |
| **Ayarlar (.env formu)** | **YouTube girişi sihirbazı** | |
| ![Ayarlar sekmesi](docs/ekran-ayarlar.png) | ![YouTube girişi](docs/ekran-youtube.png) | |

<sub>Ekran görüntülerindeki sunucular, şarkılar ve sayılar test için uydurulmuş verilerdir.</sub>

### Kurulum yolları

- **A) Masaüstü uygulamasıyla (Windows, önerilen):** 1-3. adımları yapın (Node, Java, `npm install`, Discord'da bot oluşturma), sonra uygulamayı açın: `npm --prefix desktop install` bir kez, ardından `npm run masaustu`. Kurulum dosyası ya da taşınabilir exe üretmek için `npm run masaustu:paket` (çıktı `desktop/dist/`). Uygulama `.env` dosyasını form olarak düzenler, Lavalink'i indirir, YouTube girişini adım adım yaptırır, komutları kaydeder ve botu tek düğmeyle başlatıp durdurur; aşağıdaki 4-9. adımları uygulamanın içinden yapabilirsiniz.
- **B) Komut satırıyla:** Aşağıdaki adımları sırayla izleyin.

> **İmzasız exe:** Masaüstü uygulamasının exe dosyaları kod imzası taşımaz. Windows SmartScreen ilk açılışta "Windows bilgisayarınızı korudu" uyarısı gösterebilir; "Ek bilgi" > "Yine de çalıştır" ile açabilirsiniz. Exe'yi bu depodan kendiniz derlemek en güvenli yoldur.

---

## İçindekiler

1. [Gerekenler](#1-gerekenler)
2. [Bağımlılıkları kurun](#2-bağımlılıkları-kurun)
3. [Discord'da botu oluşturun](#3-discordda-botu-oluşturun)
4. [.env dosyasını doldurun](#4-env-dosyasını-doldurun)
5. [Spotify uygulaması (isteğe bağlı)](#5-spotify-uygulaması-isteğe-bağlı)
6. [Lavalink'i indirip başlatın](#6-lavalinki-indirip-başlatın)
7. [YouTube girişi (ilk sefere özel)](#7-youtube-girişi-ilk-sefere-özel)
8. [Komutları Discord'a kaydedin](#8-komutları-discorda-kaydedin)
9. [Botu başlatın](#9-botu-başlatın)
10. [Web paneli](#10-web-paneli)
11. [Komutlar](#11-komutlar)
12. [Sık karşılaşılan hatalar](#12-sık-karşılaşılan-hatalar)
13. [Kendin düzenlemek istersen](#13-kendin-düzenlemek-istersen)
14. [Teknik notlar](#14-teknik-notlar)

Bütün komutlar bu klasörde açılmış bir **PowerShell** penceresinde yazılır. Klasörü açmanın kolay yolu: Dosya Gezgini'nde `Müzik Bot` klasörüne girin, adres çubuğuna `pwsh` yazıp Enter'a basın.

---

## 1. Gerekenler

| Program | Neden | Kontrol |
|---|---|---|
| Windows 10/11 | Masaüstü uygulaması yalnız Windows'ta çalışır. Bot ve Lavalink Node.js ve Java ile Linux/macOS'ta da çalışabilir, ancak yalnız Windows'ta denendi; başlatma betikleri PowerShell 7 ister | |
| Node.js 24 veya üstü | Botun kendisi | `node -v` |
| Java 17 veya üstü (önerilen 21) | Lavalink ses sunucusu | `java -version` |
| ffmpeg | Sesi Discord'a uygun biçime çevirir; PATH'te yoksa `npm install` ile gelen `ffmpeg-static` kullanılır | `ffmpeg -version` |
| PowerShell 7 | Başlatma betikleri (masaüstü uygulaması gerektirmez) | `pwsh -v` |

Java yoksa: [Adoptium Temurin 21](https://adoptium.net/) indirip kurun (kurulumda "Add to PATH" seçili olsun).

## 2. Bağımlılıkları kurun

```powershell
npm install
```

## 3. Discord'da botu oluşturun

1. <https://discord.com/developers/applications> adresine gidin, **New Application** deyin, bir ad verin.
2. **General Information** sayfasındaki **Application ID** değerini kopyalayın. Bu sizin `DISCORD_CLIENT_ID` değeriniz.
3. Soldan **Bot** sekmesine geçin:
   - **Reset Token** düğmesine basın, çıkan token'ı kopyalayın. Bu sizin `DISCORD_TOKEN` değeriniz. **Kimseyle paylaşmayın.** Token sızarsa yeniden "Reset Token" yapın.
   - **Privileged Gateway Intents** bölümündeki üç anahtarın (Presence, Server Members, Message Content) hiçbiri **gerekmez**, kapalı bırakın. Bot yalnız eğik çizgi komutları kullanır.
4. Botu sunucunuza davet edin. Aşağıdaki adreste `UYGULAMA_ID` yerine Application ID'nizi yazıp tarayıcıda açın:

   ```text
   https://discord.com/oauth2/authorize?client_id=UYGULAMA_ID&scope=bot+applications.commands&permissions=3165184
   ```

   `3165184` şu izinleri verir: Kanalları Görüntüle, Mesaj Gönder, Bağlantı Yerleştir, Bağlan, Konuş. (Bot çalışırken `/invite` komutu da aynı bağlantıyı verir.)

## 4. .env dosyasını doldurun

1. `.env.example` dosyasını kopyalayın ve kopyanın adını `.env` yapın:

   ```powershell
   Copy-Item .env.example .env
   ```

2. `.env` dosyasını Not Defteri ile açın (`notepad .env`) ve doldurun:
   - `DISCORD_TOKEN=` → 3. adımdaki token
   - `DISCORD_CLIENT_ID=` → Application ID
   - `LAVALINK_PASSWORD=` → **kendi uydurduğunuz** bir şifre (bot ve Lavalink bunu ortak kullanır)
   - `DISCORD_GUILD_ID=` → isteğe bağlı: sunucunuzun kimliği. Doldurursanız komutlar o sunucuda **hemen** görünür. (Discord'da Ayarlar > Gelişmiş > Geliştirici Modu'nu açın, sunucu adına sağ tıklayıp "Sunucu Kimliğini Kopyala" deyin.)
3. Diğer ayarlar (ses seviyesi, 24/7, bekleme süreleri) dosyadaki açıklamalarla birlikte gelir; varsayılanlar çoğu kişi için uygundur.
   - `TWENTY_FOUR_SEVEN=true` yaparsanız bot ses kanalından kendiliğinden hiç ayrılmaz.
   - `DEFAULT_VOLUME=80` yeni çalmaya başlarken kullanılan ses seviyesidir.
   - `PLAY_SHOW_CHOICES=true` (varsayılan): `/play` şarkı adıyla kullanılınca ilk 5 sonuç numaralı bir listede çıkar, komutu yazan kişi düğmeyle seçer (60 saniye). `false` yaparsanız liste çıkmaz, ilk sonuç doğrudan çalar. Bağlantı ve çalma listeleri her zaman doğrudan çalar.
   - `BOT_OWNER_IDS=` (isteğe bağlı): `/servers` komutunu kullanabilecek kişilerin Discord kimlikleri, virgülle ayrılmış. Boşsa bot sahibini Developer Portal'dan kendisi bulur (uygulama bir takımdaysa takım sahibi ve Admin üyeleri).

> Kurallar: `=` işaretinin yanlarına boşluk koymayın. Bir değerin içinde `#` varsa değeri tırnağa alın: `LAVALINK_PASSWORD="ab#cd"`.

## 5. Spotify uygulaması (isteğe bağlı)

Spotify bağlantıları (şarkı, albüm, çalma listesi) YouTube'daki karşılıklarıyla çalınır. Bunun için bir Spotify geliştirici uygulaması gerekir:

1. <https://developer.spotify.com/dashboard> adresine Spotify hesabınızla girin, **Create app** deyin.
2. Ad ve açıklama yazın. **Redirect URI** alanına `http://127.0.0.1:8888/callback` yazın (kullanılmıyor ama alan zorunlu). **Web API** kutusunu işaretleyin, kaydedin.
3. Uygulamanın **Settings** sayfasından **Client ID** ve **Client secret** değerlerini `.env` içindeki `SPOTIFY_CLIENT_ID` ve `SPOTIFY_CLIENT_SECRET` satırlarına yazın.
4. Lavalink'i yeniden başlatın. Açılışta "Spotify desteği: AÇIK" yazmalı.

> **Önemli:** Spotify, Şubat 2026'dan beri "Development Mode" uygulamaları için uygulama sahibinin **Spotify Premium** üyesi olmasını şart koşuyor. Premium yoksa Spotify bağlantıları hata verir; YouTube etkilenmez.

## 6. Lavalink'i indirip başlatın

Lavalink, botun sesi işleyen ayrı programıdır. Bir kez indirin:

```powershell
npm run lavalink:indir
```

Bu komut Lavalink 4.2.2'yi **yalnızca resmi GitHub sürüm sayfasından** indirir ve dosyanın SHA-256 özetini GitHub'ın yayımladığı değerle karşılaştırır. Uyuşmazsa dosyayı siler.

Başlatmak için:

```powershell
npm run lavalink
```

- İlk açılışta YouTube, Spotify ve şarkı sözü eklentilerini kendisi indirir (`lavalink/plugins` klasörüne).
- "**Lavalink is ready to accept connections.**" yazısını görünce hazırdır.
- Lavalink yalnız bu bilgisayardan (127.0.0.1) bağlantı kabul eder.
- Bu pencere açık kalmalı. Kapatmak için pencerede `Ctrl+C`.

## 7. YouTube girişi (ilk sefere özel)

YouTube botları engellediği için Lavalink bir Google hesabıyla giriş yapar.

> ⚠️ **Ana Google hesabınızı KULLANMAYIN.** Bu amaçla yeni, önemsiz bir **yan hesap** açın. YouTube bu tür kullanımı fark edip hesabı kapatabilir.

1. `npm run lavalink` ile Lavalink'i başlatın. `.env` içinde `YOUTUBE_OAUTH_REFRESH_TOKEN` boşsa pencerede şuna benzer bir satır çıkar:

   ```text
   OAUTH INTEGRATION: To give youtube-source access to your account, go to https://www.google.com/device and enter code XXX-XXX-XXX
   ```

2. Tarayıcıda <https://www.google.com/device> adresine gidin, koddaki harfleri girin ve **yan hesabınızla** izin verin.
3. Birkaç saniye içinde Lavalink penceresinde "**Token retrieved successfully**" yazar.
4. **Yeni** bir PowerShell penceresinde şunu çalıştırın; token `.env` dosyasına kendiliğinden yazılır:

   ```powershell
   npm run youtube-token
   ```

5. Lavalink'i kapatıp (`Ctrl+C`) yeniden başlatın. Artık kod sorulmaz.

## 8. Komutları Discord'a kaydedin

Bunu ilk kurulumda ve komutlar değiştiğinde bir kez yapmanız yeterli:

```powershell
npm run deploy-commands
```

> **Güncelleme notu:** Bu sürümde yeni komutlar var (`/dj`, `/playfirst`, `/servers`). Discord'da görünmeleri için `npm run deploy-commands` komutunu **bir kez yeniden** çalıştırın. Bir komutun açıklamasını `src/mesajlar.js` içinde değiştirdiğinizde de aynısını yapın.

- `DISCORD_GUILD_ID` doluysa komutlar o sunucuda hemen çıkar.
- Boşsa tüm sunuculara kaydedilir; görünmesi birkaç dakika sürebilir. Görünmezse Discord'u `Ctrl+R` ile yenileyin.
- Yalnız tanımları denetlemek için (token gerekmez): `npm run deploy-commands -- --check`

## 9. Botu başlatın

İki yol var:

**A) Tek komutla (önerilen):**

```powershell
npm run hepsi
```

Lavalink kapalıysa ayrı bir pencerede açar, hazır olmasını bekler, sonra botu bu pencerede başlatır.

**B) Ayrı ayrı:** bir pencerede `npm run lavalink`, ikinci pencerede:

```powershell
npm start
```

"Discord'a giriş yapıldı" ve "Lavalink bağlandı" yazılarını gördüyseniz bot hazırdır. Bir ses kanalına girip `/play` deneyin.

**Kurulum kontrolü:** Bir şey çalışmıyorsa `npm run kontrol` çalıştırın; neyin eksik olduğunu tek tek yazar.

## 10. Web paneli

Bot çalışırken tarayıcıdan da yönetilebilir: çalan şarkı ve ilerleme, kuyruk, ses seviyesi, duraklat/devam, atla, durdur, karıştır, tekrar, kuyruktan silme ve şarkı ekleme. Sayfa canlı güncellenir. Panel botla aynı programın içinde çalışır, ayrıca başlatmanız gerekmez.

**Kim ne yapabilir?** Panele Discord hesabıyla girilir. Bir sunucuyu yalnız o sunucunun üyeleri görebilir. Müziği **yalnızca botla aynı ses kanalında olan** üyeler yönetebilir; diğer üyeler izler. (Bot henüz bir kanalda değilse, ses kanalındaki bir üye şarkı ekleyince bot o kanala girer.) Sunucuda `/dj` ile bir DJ rolü ayarlıysa panelde de Discord'daki kural geçerlidir: kontrol düğmelerini yalnız DJ rolü olanlar, sunucu yöneticileri ya da botla kanalda tek başına olan kişi kullanabilir (şarkı eklemek herkese açık). Bu kurallar sunucu tarafında, Discord'un bilgisine göre denetlenir.

### Kurulum

1. Developer Portal'da uygulamanızı açın > **OAuth2** sekmesi:
   - **Client Secret** altında **Reset Secret** deyin ve çıkan değeri `.env` içindeki `DISCORD_CLIENT_SECRET=` satırına yazın. **Kimseyle paylaşmayın.**
   - **Redirects** bölümünde **Add Redirect** deyip tam olarak şunu yazın ve kaydedin:

     ```text
     http://127.0.0.1:3000/auth/callback
     ```

     (`PANEL_PUBLIC_URL` değerini değiştirdiyseniz onun sonuna `/auth/callback` ekleyin.)
2. `.env` içinde:
   - `PANEL_ENABLED=true`
   - `PANEL_SESSION_SECRET=` → en az 32 karakterlik rastgele bir metin. Üretmek için PowerShell'de:

     ```powershell
     node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
     ```

3. Botu yeniden başlatın. Konsolda `Web paneli açık: http://127.0.0.1:3000` yazar. Tarayıcıda **tam olarak bu adresi** açın (`localhost` değil `127.0.0.1`; adres farklı olursa giriş güvenlik kontrolünden geçmez).
4. Panel adresi `/help` ve `/stats` komutlarında da görünür.

Paneli istemiyorsanız `PANEL_ENABLED=false` yapın; bot eskisi gibi çalışır ve web sunucusu hiç başlamaz.

### Paneli başka cihazlardan ya da internetten açmak

Varsayılan olarak panel yalnız bu bilgisayardan açılır (127.0.0.1). Bu en güvenli ayardır.

> ⚠️ **Güvenlik uyarısı:** Paneli internete açacaksanız `PANEL_HOST`'u değiştirip modemden port yönlendirmek **yerine** HTTPS sağlayan bir **ters proxy** kullanın (ör. [Caddy](https://caddyserver.com/) otomatik sertifika alır). Şifresiz (http) bağlantıda oturum çereziniz ağda okunabilir. Önerilen düzen:
>
> - Panel `PANEL_HOST=127.0.0.1` ile yalnız yerelde dinlemeye devam eder; ters proxy aynı bilgisayarda çalışıp `https://alanadiniz` adresini `127.0.0.1:3000`'e yönlendirir.
> - `.env`: `PANEL_PUBLIC_URL=https://alanadiniz` ve `PANEL_TRUST_PROXY=true`.
> - Developer Portal'daki Redirect adresini `https://alanadiniz/auth/callback` olarak güncelleyin.
> - Ev internetinde dışarıdan erişim için sabit IP ya da dinamik DNS gerekebilir; ayrıca modeminizde yalnız 443 portunu açın.

## 11. Komutlar

| Komut | Ne yapar |
|---|---|
| `/play şarkı:` | Şarkı adı yazılırsa ilk 5 sonucu listeler, düğmeyle seçtiğinizi çalar (`PLAY_SHOW_CHOICES`); bağlantı ya da çalma listesi doğrudan çalar |
| `/search şarkı:` | 10 sonuç listeler, menüden seçtiğinizi çalar |
| `/playfirst sıra:` | Kuyruktaki şarkıyı başa alır (çalan şarkıdan sonra o çalar) |
| `/skip` | Çalan şarkıyı atlar |
| `/skipto sıra:` | Kuyrukta o sıradaki şarkıya atlar |
| `/pause`, `/resume` | Duraklatır / devam ettirir |
| `/stop`, `/disconnect` | Durdurur, kuyruğu temizler, kanaldan ayrılır |
| `/queue sayfa:` | Kuyruğu sayfa sayfa gösterir (◀️ ▶️ düğmeleri) |
| `/nowplaying` | Çalan şarkı ve ilerleme çubuğu |
| `/loop` | Çalan şarkıyı tekrarla (aç/kapat) |
| `/loopqueue` | Tüm kuyruğu tekrarla (aç/kapat) |
| `/shuffle` | Kuyruğu karıştırır |
| `/remove sıra:` | Kuyruktan bir şarkı çıkarır |
| `/move parça: konum:` | Bir şarkının sırasını değiştirir |
| `/clear` | Kuyruğu temizler (çalan şarkı sürer) |
| `/seek zaman:` | Şarkıda zamana atlar (`1:30`, `90`, `2dk 10sn`) |
| `/volume seviye:` | Ses seviyesi (1–150; boş bırakılırsa mevcut seviyeyi söyler) |
| `/bassboost seviye:` | Bas güçlendirme: Kapalı, Düşük, Orta, Yüksek |
| `/grab` | Çalan şarkıyı size özel mesajla gönderir |
| `/lyrics şarkı:` | Şarkı sözleri (boşsa çalan şarkı) |
| `/help`, `/invite`, `/stats` | Yardım, davet bağlantısı, istatistikler |
| `/dj rol:` / `/dj kaldır:True` | DJ rolünü ayarlar ya da kaldırır (aynı rolü yeniden seçmek de kaldırır); boş bırakılırsa şu anki rolü söyler. Yalnız "Sunucuyu Yönet" izni olanlar |
| `/servers` | Botun bulunduğu sunucuları ad ve üye sayısıyla listeler. Yalnız bot sahibi kullanır, cevabı yalnız o görür |

**DJ rolü:** Bir sunucuda `/dj` ile rol ayarlanınca kontrol komutlarını (`/skip`, `/skipto`, `/stop`, `/disconnect`, `/pause`, `/resume`, `/volume`, `/seek`, `/remove`, `/move`, `/clear`, `/shuffle`, `/loop`, `/loopqueue`, `/bassboost`, `/playfirst`) yalnızca o role sahip olanlar, sunucu yöneticileri ve botla ses kanalında tek başına olan kişi kullanabilir; diğerleri "Bu komutu kullanma yetkin yok." yanıtı alır. `/play`, `/search`, `/queue` gibi komutlar herkese açık kalır. Liste `src/bot/dj.js` içindedir. Ayar `data/sunucular.json` dosyasında saklanır (bot yeniden başlasa da kalır; dosya bozulursa bot çökmez, yedeğini alıp boş ayarla devam eder).

**Sıradaki sonuç:** Aramayla eklenen bir şarkı "yaş kısıtlamalı" ya da "kullanılamıyor" hatası verirse bot aynı aramanın sıradaki sonucunu **bir kez** dener ve bunu kanala yazar.

Kontrol komutlarını kullanmak için botla **aynı ses kanalında** olmanız gerekir. Ses kanalında kimse kalmazsa bot `LEAVE_WHEN_EMPTY_SECONDS` saniye sonra ayrılır; kuyruk bittiğinde de `LEAVE_AFTER_QUEUE_END_SECONDS` saniye bekleyip ayrılır (24/7 açıksa ayrılmaz).

## 12. Sık karşılaşılan hatalar

| Gördüğünüz | Sebep ve çözüm |
|---|---|
| `HATA: DISCORD_TOKEN boş` | `.env` yok ya da token yazılmamış. 4. adıma bakın. |
| `Discord token'ı geçersiz` | Token yanlış kopyalanmış ya da sıfırlanmış. Developer Portal > Bot > Reset Token ile yenisini alın. |
| `Discord'a bağlanılamadı` | İnternet yok ya da Discord ağınızda engelli. Bağlantıyı (ve kullanıyorsanız erişim aracınızı) kontrol edip tekrar deneyin. |
| `Lavalink'e ulaşılamıyor` / komutlarda "Müzik sunucusuna bağlanılamıyor" | Lavalink penceresi kapalı. `npm run lavalink` ile açın, "ready" yazısını bekleyin. |
| `Lavalink şifreyi reddetti` | Lavalink eski bir şifreyle açık kalmış. Lavalink'i kapatıp yeniden başlatın. |
| `Java bulunamadı` | Java kurulu değil ya da PATH'te değil. 1. adıma bakın, kurulumdan sonra PowerShell'i kapatıp açın. |
| `Lavalink.jar yok` | `npm run lavalink:indir` çalıştırın. |
| Komutlar Discord'da görünmüyor | `npm run deploy-commands` çalıştırın; global kayıtta birkaç dakika bekleyin, Discord'u `Ctrl+R` ile yenileyin. |
| "YouTube bu parçayı çalmak için oturum açılmasını istiyor" | YouTube girişi yapılmamış ya da token geçersiz. 7. adımı (yeniden) yapın. |
| "YouTube şu an bu parçayı vermiyor" / Lavalink günlüğünde `All clients failed` | YouTube eklentisi YouTube'daki bir değişiklikle bozulmuş. `lavalink/application.yml`'deki youtube-plugin sürümünün güncel olup olmadığına bakın (Teknik notlar > YouTube eklentisi), sonra Lavalink'i ve botu yeniden başlatın. |
| Lavalink penceresinde sürekli `google.com/device` kodu çıkıyor | Giriş tamamlanmamış ya da token `.env`'ye kaydedilmemiş. 7. adımdaki `npm run youtube-token` adımını yapın. |
| "Spotify desteği kapalı" | `.env`'de Spotify anahtarları boş ya da Lavalink anahtarlar girildikten sonra yeniden başlatılmamış. |
| Spotify bağlantısı hata veriyor ama anahtarlar dolu | Spotify uygulamasının sahibinin Premium üyeliği yok (5. adımdaki not) ya da anahtarlar yanlış. |
| Bot kanala giriyor ama ses yok | Botun kanalda **Konuş** izni var mı? Lavalink penceresinde hata var mı? Lavalink sürümünün 4.2.x olduğunu `npm run kontrol` ile doğrulayın. |
| `/grab` "özel mesaj gönderemedim" diyor | Discord'da sunucu adı > Gizlilik Ayarları > "Doğrudan Mesajlar" açık olmalı. |
| Port 2333 kullanımda | Başka bir Lavalink zaten açık. Diğer pencereyi kapatın ya da Görev Yöneticisi'nden `java.exe`'yi sonlandırın. Portu başka bir program kullanıyorsa `.env`'de `LAVALINK_PORT`'u değiştirin (Lavalink ve bot birlikte değişir). |
| `Web paneli açılmadı: ... DISCORD_CLIENT_SECRET gerekli` | 10. adımdaki Client Secret `.env`'ye yazılmamış. Bot panelsiz çalışmaya devam eder. |
| Discord girişte "Invalid OAuth2 redirect_uri" diyor | Developer Portal > OAuth2 > Redirects'teki adres `PANEL_PUBLIC_URL` + `/auth/callback` ile birebir aynı değil. |
| Panelde "Giriş doğrulanamadı (güvenlik kontrolü)" | Paneli `PANEL_PUBLIC_URL`'deki adresten açmadınız (ör. `localhost` yerine `127.0.0.1` kullanın) ya da giriş sayfası çok uzun açık kaldı. Tekrar deneyin. |
| Panelde düğmeler gri, "İzleme modundasınız" | Botla aynı ses kanalında değilsiniz. Discord'da botun kanalına girin; sayfa kendiliğinden güncellenir. |
| `3000 portu başka bir program tarafından kullanılıyor` | `.env`'de `PANEL_PORT`'u (ör. 3001) değiştirin; `PANEL_PUBLIC_URL`'yi ve Developer Portal'daki Redirect adresini de buna göre güncelleyin. |
| Bot yeniden başlayınca panelden çıkış yapılmış oluyor | `PANEL_SESSION_SECRET` boş; oturumlar zaten bellekte tutulduğu için yeniden başlatmada düşer, bu normaldir. Tekrar giriş yapın. |

## 13. Kendin düzenlemek istersen

Kod bilmeden değiştirebileceğiniz her şey iki dosyada toplandı. Değişiklikten sonra botu kapatıp (`Ctrl+C`) yeniden başlatın. Bir şey bozulursa `npm test` hangi dosyada sorun olduğunu söyler.

| Dosya | İçinde ne var |
|---|---|
| `src/mesajlar.js` | Botun Discord'da yazdığı **bütün** mesajlar, komut açıklamaları ve web panelinin hata mesajları, Türkçe başlıklarla (panelin sayfa yazıları `src/panel/public` içinde; konsol kayıtları bot sahibine yönelik olduğu için kendi dosyalarında) |
| `src/gorunum.js` | Hata rengi, botun durumu ("Dinliyor: /help"), seçim listesindeki sonuç sayısı ve süresi |
| `.env` | Ana renk (`EMBED_COLOR`), ses, 24/7, seçim listesi açık/kapalı (`PLAY_SHOW_CHOICES`), bot sahibi (`BOT_OWNER_IDS`), `/help` altındaki bağlantılar (`BRAND_SUPPORT_URL`, `BRAND_AUTHOR_NAME`, `BRAND_AUTHOR_URL`; boşsa gösterilmez) |

Dosyaların başında "BURAYA DOKUNMANA GEREK YOK" yazanlar (panel güvenliği, Lavalink kurtarma, DAVE ses ayarları) botun güvenli ve dayanıklı çalışmasını sağlar; onları değiştirmeyin.

**Bir mesajı değiştirmek:** `src/mesajlar.js` dosyasını açın, değiştirmek istediğiniz yazıyı bulun (Not Defteri'nde `Ctrl+F`), yalnız tırnak içindeki metni değiştirin. Örnek, `/skip` cevabı:

```js
  skip: {
    aciklama: 'Çalan şarkıyı atlar',
    tamam: (sarki) => `⏭️ Atlandı: ${sarki}`,   // ← "⏭️ Geçtim: ${sarki}" yapabilirsiniz
  },
```

`${sarki}` gibi kısımları bot doldurur; onları silmeyin. `aciklama` satırını değiştirdiyseniz `npm run deploy-commands` çalıştırın.

**Rengi değiştirmek:** Mesaj kutularının ana rengi `.env` içindeki `EMBED_COLOR=5865F2` satırıdır (başında `#` olmadan 6 haneli renk kodu, ör. kırmızı için `ED4245`). Hata mesajlarının rengi `src/gorunum.js` içinde `hata: 0xed4245` satırıdır (burada başa `0x` yazılır).

**Durum yazısını değiştirmek:** `src/gorunum.js` > `durum`: `tur: 'Oynuyor'`, `metin: 'müzik'` yaparsanız botun altında "Oynuyor: müzik" yazar.

**Yeni basit bir komut eklemek** (örnek: `/ping`):

1. `src/commands/ping.js` adında yeni bir dosya oluşturun:

   ```js
   // /ping: botun cevap verip vermediğini gösterir.
   import { komutlar } from '../mesajlar.js';
   import { guildCommand, replySuccess } from './_helpers.js';

   export const data = guildCommand('ping');

   export async function execute(interaction) {
     await replySuccess(interaction, komutlar.ping.tamam(interaction.client.ws.ping));
   }
   ```

2. `src/mesajlar.js` içinde `komutlar` bölümüne (alfabetik sıra şart değil) ekleyin:

   ```js
     ping: {
       aciklama: 'Botun gecikmesini gösterir',
       tamam: (ms) => `🏓 Pong! ${ms} ms`,
     },
   ```

3. `npm run deploy-commands` çalıştırın, botu yeniden başlatın. Komut dosyası kendiliğinden yüklenir. (`npm test` yeni komutu "beklenmeyen komut" diye işaretler; `test/commands.test.js` içindeki listeye `'ping'` eklemeniz yeterli.)

Müzik kontrol eden bir komut yazdıysanız (ör. çalanı durduran) ve DJ rolüne tabi olsun istiyorsanız adını `src/bot/dj.js` içindeki listeye ekleyin.

## 14. Teknik notlar

**Klasör yapısı**

```text
src/
  index.js            giriş noktası (yapılandırma, Discord'a giriş, anlaşılır hata mesajları)
  app.js              tüm parçaları birleştirir, giriş yapmadan "context" döndürür
  config.js           .env okuma ve doğrulama
  mesajlar.js         Discord'da görünen bütün metinler ve komut açıklamaları
  gorunum.js          renk, durum yazısı, seçim listesi ayarları
  music/
    MusicService.js   oynatıcı servisi: tüm müzik işlemleri ve durum (getState)
    lavalink.js       Lavalink REST istemcisi (arama, YouTube akışı, sözler) ve erişilebilirlik izleyicisi
    engine.js         ses motoru: sunucu başına GuildPlayer, olayları tek yerden yayar
    GuildPlayer.js    Discord ses bağlantısı (@discordjs/voice), ffmpeg hattı, kuyruk/tekrar/ses/bas/sarma
    Queue.js          şarkı kuyruğu (bellekte)
    audioSource.js    parçanın sesi nereden alınır (YouTube kimliği; Spotify -> YouTube eşlemesi)
    ffmpeg.js         ffmpeg'i bulma, komut satırı ve bas filtreleri
    recovery.js       Lavalink (ses kaynağı) koparsa parçayı kaldığı yerden sürdürme
    idleWatcher.js    boş kanaldan ayrılma
    errors.js         Türkçe hata kodları
  bot/                komut yönlendirme, "şimdi çalıyor" duyuruları, izinler,
                      DJ kuralı (dj.js), sunucu ayarları (serverSettings.js), bot sahibi (owner.js),
                      durum yazısı (presence.js), durum dosyası (durumDosyasi.js), sayaçlar (istatistik.js)
  commands/           her eğik çizgi komutu ayrı dosyada; _secim.js şarkı seçme listesi,
                      _sayfalar.js sayfalı listeler, _helpers.js ortak yardımcılar
  panel/
    index.js          paneli yalnız PANEL_ENABLED=true ise yükler ve başlatır
    server.js         Express uygulaması: sayfalar, OAuth2, JSON API, SSE
    access.js         yetki kuralları (üyelik + aynı ses kanalı)
    oauth.js          Discord OAuth2 (fetch ile, ek paket yok)
    security.js       güvenlik başlıkları, CSRF, rastgele anahtarlar
    sessionStore.js   süresi dolanı temizleyen bellek içi oturum deposu
    public/           arayüz (HTML/CSS/JS, harici CDN yok)
data/sunucular.json   sunucu başına ayarlar (DJ rolü); bot oluşturur, git'e girmez
data/durum.json       botun anlık durumu (masaüstü uygulaması okur); git'e girmez
data/istatistik.json  kalıcı sayaçlar (çalınan şarkı, kullanılan komut); git'e girmez
lavalink/             application.yml, indir.ps1, baslat.ps1
scripts/              deploy-commands, youtube-token, kontrol, check, hepsini-baslat
test/                 node:test testleri
```

**Masaüstü uygulamasıyla sözleşme:** `desktop/` klasöründeki uygulama botu `node src/index.js` ile başlatır ve konsol satırlarını (`[tarih] SEVİYE [kaynak] mesaj`, "Discord'a giriş yapıldı: ...", "Lavalink bağlandı", "Web paneli açık:") okur. `test/contract.test.js` bunları sabitler; değiştirmeniz gerekirse masaüstü uygulamasını da birlikte güncelleyin.

**Durum dosyası (`data/durum.json`):** Bot, masaüstü uygulamasının "Sunucular" ve "İstatistikler" sekmeleri için durumunu bu yerel dosyaya yazar (port açılmaz). Girişte, 15 saniyede bir, sunucu ve şarkı olaylarında en fazla 2 saniyede bir ve kapanırken son kez (`"running": false`) yazılır; her yazım geçici dosya + ad değiştirme ile yapılır, yarım dosya kalmaz. Şema (`schemaVersion: 1`):

- `updatedAt`, `running`, `pid`
- `bot`: `username`, `id`, `avatarUrl`, `startedAt`, `uptimeMs`, `pingMs`, `guildCount`, `memberCount`, `memory` (`rss`, `heapUsed`, `heapTotal`), `versions` (`node`, `discordJs`)
- `lavalink`: `connected`, `version`, `players`, `playingPlayers`, `uptimeMs`, `cpuLoad`, `memoryUsed`
- `sayaclar.toplam` ve `sayaclar.oturum`: `songsPlayed`, `commandsUsed`, `commands` (komut başına), `topSongs` (en çok çalınan 10: `title`, `uri`, `count`), `songsByGuild`
- `sunucular[]`: `id`, `name`, `iconUrl`, `memberCount`, `joinedAt`, `djRole`, `voice` (`channelName`, `listeners`), `playing` (`title`, `author`, `uri`, `positionMs`, `durationMs`, `isStream`, `paused`), `queueLength`, `repeatMode`, `volume`, `songsPlayed`

Dosyada token, şifre ya da kullanıcı bilgisi (şarkıyı kim istedi gibi) yoktur. Kalıcı sayaçlar `data/istatistik.json` dosyasında birkaç saniyede bir toplu yazılır; dosya bozulursa yedeği alınır (`.bozuk-<zaman>`) ve sayaçlar sıfırdan başlar.

**Mimari:** Komutlar ve web paneli ses motoruna ya da Lavalink'e doğrudan dokunmaz; her şey `MusicService` üzerinden yapılır. `getState(guildId)` JSON'a çevrilebilir bir anlık görüntü verir (çalan şarkı, kuyruk, ses, tekrar modu, konum), `pause/resume/skip/stop/setVolume/...` kontrol eder, `stateChanged` olayı canlı güncellemeyi besler. Hatalar `MusicError` olarak `code` alanıyla gelir; panel bunları HTTP durum kodlarına çevirir.

**Web paneli güvenliği:** Express 5.3.0, express-session 1.19.0, express-rate-limit 8.7.1. Discord OAuth2 akışı `fetch` ile yazıldı (passport-discord 2020'den beri güncellenmiyor). Önlemler: tek kullanımlık rastgele OAuth `state`; girişte oturum kimliğinin yenilenmesi; `httpOnly` + `SameSite=Lax` çerez (https adreste `Secure`); değiştiren her istekte kaynak (Origin) denetimi ve oturuma bağlı CSRF anahtarı; giriş, API ve kontrol istekleri için ayrı istek sınırları; 4 KB gövde sınırı ve her alanın doğrulanması; sıkı Content-Security-Policy. Discord erişim anahtarı yalnız sunucudaki oturum deposunda durur, tarayıcıya hiç gönderilmez; çıkışta Discord'da iptal edilir. Canlı güncelleme için Server-Sent Events kullanılıyor (tek yönlü, ek kütüphane gerektirmez).

**Şarkı sözleri:** LavaLyrics eklentisi + LavaSrc'nin iki söz kaynağı kullanılıyor: **YouTube Music** (Musixmatch/LyricFind lisanslı sözler) ve **LRCLIB** (açık, anahtar gerektirmeyen söz veritabanı). İkisi de API anahtarı istemez, sözler Lavalink içinde çözülür ve botun ayrıca bir web kazıyıcıya ihtiyacı kalmaz. Spotify ve Deezer söz kaynakları çerez (sp_dc / arl) gerektirdiği için kapalı.

**Ses gönderimi neden Lavalink'te değil:** Bazı ağ ve Windows ortamlarında Lavalink'in ses kütüphanesinin (koe) gönderdiği ses paketleri Discord'un ses sunucusuna ulaşmıyordu: bot kanala bağlanıyor ama dinleyenler hiçbir şey duymuyordu. Sesi botun kendisinin `@discordjs/voice` + `@snazzah/davey` (DAVE) ile göndermesi aynı ortamlarda güvenilir çalıştı. Bu yüzden Lavalink yalnız arama ve ses kaynağı olarak (REST) kullanılıyor; Discord'a sesi bot gönderiyor.

**Ses hattı:** `/play` → Lavalink `/v4/loadtracks` ile çözer → `GuildPlayer` kanala `@discordjs/voice` ile bağlanır (kendini sağırlaştırır) → parçanın sesi youtube-plugin'in REST rotasından (`GET /youtube/stream/{videoId}`, Lavalink şifresiyle; eklenti istemci sırasını, OAuth'u ve imza çözmeyi kendisi halleder) alınır → ffmpeg 48 kHz/2 kanal/16 bit PCM'e çevirir (`/seek` için `-ss`, `/bassboost` için `bass` + `alimiter` filtresi) → `@discordjs/opus` ile Opus'a kodlanıp DAVE ile şifrelenerek gönderilir. Ses seviyesi anında, ffmpeg'siz uygulanır (`inlineVolume`); bas seviyesi değişince parça aynı konumdan yeniden başlar. Konum = sarılan nokta + çalınan ses süresi (duraklamalar sayılmaz). Lavalink'in web katmanı `@EnableWebMvc` kullandığı için `spring.mvc.async.request-timeout` ayarı okunmaz ve akış yanıtına sunucu konteynerinin 30 saniyelik varsayılan zaman aşımı uygulanır; çalma hızında okunan bir akış ~30 saniyede kesilir (`AsyncRequestTimeoutException`). Bot bu yüzden akışı Lavalink'in verdiği hızla **önceden belleğe indirir** (bir parça 1-2 saniyede iner) ve ffmpeg'e oradan verir; kaynak yine de erken biterse parça aynı konumdan en çok 3 kez yeniden açılır. Spotify (ve LavaSrc'nin diğer eşlenen kaynakları) parça çalınırken YouTube'da aranır: önce ISRC, sonra "başlık sanatçı" (`src/music/audioSource.js`). SoundCloud/Bandcamp/Twitch gibi YouTube dışı kaynaklar aranabilir ama **şimdilik çalınamaz**; bot Türkçe "şimdilik desteklenmiyor" der. Doğrulama: `npm test` içindeki `test/playback.test.js`, `test/lavalinkRest.test.js`, `test/musicService.test.js`.

**Lavalink yeniden başlarsa:** Ses bağlantısı artık Lavalink'e bağlı olmadığı için yalnız çalan parçanın kaynak akışı kesilir. Bot parçayı o konumda askıya alır, "kurtarılıyor" işaretler (kontrol komutları "Müzik sunucusu yeniden bağlanıyor" der; `/stop` her zaman çalışır ve kurtarmayı iptal eder) ve Lavalink'e tekrar ulaşınca aynı parçayı aynı konumdan sürdürüp kanala haber verir. Parça sürdürülemezse sıradakine geçer. Lavalink 60 saniye içinde dönmezse 24/7 açıkken kanalda bekler (çalma durur), değilse kanaldan ayrılır; ikisini de Türkçe bildirir (`src/music/recovery.js`, testi `test/recovery.test.js`).

**YouTube eklentisi (snapshot, commit ile sabit):** `dev.lavalink.youtube:youtube-plugin:2be8e542d3f6f178e048dca565892684c2e40177` (youtube-source master, 2026-09-17), `snapshot: true` ile Lavalink'in snapshot deposundan (maven.lavalink.dev/snapshots) iner. Neden: son sürüm 1.18.2 Kasım 2026'da videoların çoğunu çalamıyordu ("All clients failed": TV'de "The page needs to be reloaded", ANDROID_VR'de "requires login", WEB'de format yok). Master'daki TV User-Agent düzeltmesi (#233, b33460b) tek başına yetmedi; TV/WEB/MWEB'de imza şifresi çözülemiyor ("Must find sig function", bkz. youtube-source #240). Çözümü aynı snapshot'taki "make IOS playable" (6579cdf) değişikliği getirdi: `IOS` istemcisi imza çözmeye ihtiyaç duymuyor. Bu yüzden çalma sırası `IOS` → `TV` (OAuth) → `MUSIC` → `ANDROID_VR` → `WEB` → `WEBEMBEDDED`. IOS'ta arama boş sonuç döndüğü için `clientOptions.IOS.searching: false`. Doğrulama (Discord'suz, ayrı test Lavalink'i): `_VOROSc1VeU`, `JJPlzNajdUs`, `dQw4w9WgXcQ`, `cpp69ghR1IM` için `/youtube/stream` gerçek ses verdi ve Lavalink oynatıcısında TrackException olmadı. 1.18.2 + IOS denendi, çalışmadı. Yeni bir youtube-source sürümü çıkınca sürüm numarasına dönülmeli. Lavalink açılışta eski eklenti jar'ını kendisi siler.

**Kalan risk ve seçenekler:** IOS da bozulursa sıradaki adım bir "remote cipher" sunucusudur (youtube-source README > Using a remote cipher server). Yerelde çalıştırılabilecek kikkia/yt-cipher Deno ya da Docker gerektiriyor ve lisansı belirtilmemiş. Genel sunucu (cipher.kikkia.dev) kurulum istemez ama YouTube oynatıcı betiğinin adresi ile şifreli imza değerleri ve sunucunuzun IP'si o üçüncü tarafa gider; varsayılan olarak açılmadı.

**Masaüstü uygulaması (`desktop/`):** Electron 45 ile yazılmış Windows uygulaması. Botu (`node src/index.js`) ve Lavalink'i (`java -jar`) gizli süreçler olarak başlatır, konsol çıktısını okuyup durum kartlarına ve "Kayıtlar" sekmesine çevirir; `data/durum.json` dosyasından "Sunucular" ve "İstatistikler" sekmelerini doldurur. Uygulama çökse bile bot ve Lavalink süreçlerini kapatan ayrı bir süreç koruyucu (watchdog) çalışır. Güvenlik: `contextIsolation`, `sandbox`, beyaz listeli IPC, sıkı CSP (görseller yalnız `cdn.discordapp.com`), Electron fuse'ları (RunAsNode, NODE_OPTIONS ve `--inspect` kapalı; ASAR bütünlük denetimi açık). Testler: `npm --prefix desktop test`.

**Geliştirici komutları**

```powershell
npm test               # birim ve başlangıç testleri
npm run check          # tüm .js dosyaları için node --check + komut tanımı denetimi
npm run format:check   # Prettier denetimi
npm run kontrol        # kurulum kontrolü
npm --prefix desktop test   # masaüstü uygulamasının testleri
```

## Bilinen sınırlar

- **Kaynaklar:** Yalnız YouTube ve Spotify bağlantıları ile şarkı adları çalınabilir. Spotify bağlantıları YouTube'daki karşılığıyla çalınır ve Spotify uygulamasının sahibinin **Premium** üyesi olması gerekir (5. adım). SoundCloud, Bandcamp, Twitch gibi kaynaklar aranabilir ama şimdilik çalınamaz.
- **Canlı yayın yok:** YouTube canlı yayınları çalınamaz.
- **Sarma yavaş olabilir:** Parçanın sesi önce belleğe indirilir; uzun parçalarda `/seek` birkaç saniye sürebilir.
- **Bellek:** Çalan her parça sunucu başına bellekte tutulur; aynı anda çok sunucuda uzun parçalar çalmak bellek kullanımını artırır. Lavalink de ayrıca bellek kullanır (`LAVALINK_JAVA_MEMORY`, varsayılan 512 MB).
- **YouTube değişiklikleri:** YouTube sık değiştiği için YouTube eklentisi zaman zaman bozulur. Bu sürüm, videoların çoğunu çalabilen bir youtube-plugin **snapshot** sürümüne (commit ile) sabitlenmiştir, çünkü son kararlı sürüm (1.18.2) bunları çalamıyordu; ayrıntı yukarıda "YouTube eklentisi". Yeni bir kararlı sürüm çıkınca ona dönülmeli.
- **Platform:** Masaüstü uygulaması yalnız Windows içindir; bot yalnız Windows'ta denenmiştir.

## Sorumluluk reddi

Bu proje resmi değildir; YouTube, Google, Spotify ya da Discord ile hiçbir bağlantısı yoktur ve onlar tarafından desteklenmez. Botu kullanan kişi, kendi kullanımından ve bu platformların kullanım şartlarına uymaktan kendisi sorumludur. YouTube girişi için **ana Google hesabınızı kullanmayın**; bu tür kullanım fark edilirse hesap kapatılabilir, bu yüzden yalnız bu iş için açılmış önemsiz bir yan hesap kullanın. Yazılım "olduğu gibi" sunulur; ayrıntı için [LICENSE](LICENSE).

## Üçüncü taraf bileşenler

Bu depo aşağıdaki projeleri **içermez**; `npm install`, `npm run lavalink:indir` ve Lavalink'in ilk açılışı onları kendi kaynaklarından indirir. Lisanslar ilgili depolardan doğrulandı.

| Bileşen | Ne için | Lisans |
|---|---|---|
| [Lavalink](https://github.com/lavalink-devs/Lavalink) | Arama, kaynak çözme, YouTube ses akışı | MIT |
| [youtube-source / youtube-plugin](https://github.com/lavalink-devs/youtube-source) | Lavalink için YouTube kaynağı | MIT |
| [LavaSrc](https://github.com/topi314/LavaSrc) | Spotify eşleme, söz kaynakları | Apache-2.0 |
| [LavaLyrics](https://github.com/topi314/LavaLyrics) | Şarkı sözleri | Apache-2.0 |
| [discord.js](https://github.com/discordjs/discord.js) | Discord istemcisi | Apache-2.0 |
| [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) | Ses bağlantısı | Apache-2.0 |
| [@discordjs/opus](https://github.com/discordjs/opus) | Opus kodlama | MIT |
| [@snazzah/davey](https://github.com/Snazzah/davey) | DAVE uçtan uca şifreli ses | MIT |
| [Express](https://github.com/expressjs/express), express-session, express-rate-limit | Web paneli | MIT |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) (isteğe bağlı) | PATH'te ffmpeg yoksa ffmpeg ikili dosyası | GPL-3.0-or-later (indirdiği FFmpeg derlemeleri de GPL) |
| [Electron](https://github.com/electron/electron), [electron-builder](https://github.com/electron-userland/electron-builder) | Masaüstü uygulaması | MIT |

## Lisans, katkı ve güvenlik

- Lisans: [MIT](LICENSE).
- Katkı: [CONTRIBUTING.md](CONTRIBUTING.md).
- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md) (lütfen herkese açık issue açmayın).

---

Yapımcı: Kutluay DOLKAN · [Instagram](https://www.instagram.com/kutluaydolkan/)
