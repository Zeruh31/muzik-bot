// Sesli komutların Türkçe kalıpları. Yeni bir söyleyiş eklemek için ilgili niyetin `kaliplar` listesine bir satır
// yazman yeter (README > "Kendin düzenlemek istersen" > Sesli komut kalıpları). Bir kalıp uyandırma sözünden
// sonraki cümlenin TAMAMIYLA eşleşmelidir; bu, gündelik konuşmanın komut sanılmasını önler.
//
// Kalıp yazımı (harfler katlanmış yazılır: ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u; noktalama yok):
//   kelime          o kelime (6+ harfli kelimede tek harf hatası tek bir niyete uyuyorsa kabul edilir)
//   a|b|c           seçeneklerden biri (tek kelimeler; "iptal et" gibi iki kelimeyi ayrı bir kalıp olarak yazın)
//   [a|b]           isteğe bağlı:                  "[bir] sonraki [sarki|sarkiya]"
//   {sorgu}         şarkı adı (bir ya da birkaç kelime, söylendiği gibi): "{sorgu} ac"
//   {ad}            kayıtlı liste adı:             "{ad} listemi cal"
//   {sayi}          sayı (rakamla ya da yazıyla, "yüzde" ve "%" olabilir): "sesi {sayi} yap"
//   {sure}          süre: "otuz saniye", "1 dakika", "yarım dakika", "bir buçuk dakika"
//   {konum}         mutlak konum: "2:30'a", "1 dakika 30 saniyeye", "ikinci dakikaya" (sondaki -e/-a eki şart)
//   {sira}          sıra: "üçüncü", "3", "3.", "üçüncüsü"
// Dolgu kelimeleri (DOLGU) her yerde atlanır; şarkı adının içinde atlanmaz.
// `ornekler`: README'de ve "anlamadım ... mı dediniz?" önerisinde gösterilen yazımlar (Türkçe harflerle).
// `yedek: true` olan niyet yalnız başka hiçbir niyet eşleşmezse denenir (ör. "<şarkı> aç").

/** Words skipped anywhere around a command ("lütfen", "abi", "şu", "bir"). */
export const DOLGU = Object.freeze([
  'su',
  'bir',
  'bi',
  'biraz',
  'lutfen',
  'abi',
  'kanka',
  'hadi',
  'haydi',
  'misin',
  'musun',
  'artik',
  'simdi',
  'bakalim',
  'ya',
  'bana',
  'bize',
  'sen',
  'tamam',
  'acil',
  'da',
  'de',
]);

/** Short words Whisper leaves after a song or list name ("Tarkan'ı" → "tarkan ı"). */
export const AD_EKLERI = Object.freeze([
  'i',
  'yi',
  'u',
  'yu',
  'a',
  'ya',
  'e',
  'ye',
  'ni',
  'nu',
  'in',
  'un',
  'nin',
  'nun',
]);

/**
 * Words that alone are not a song: "<these> aç" is not a play command ("sesi aç" is volume, "müziği aç" resume).
 * A song or list name must have at least one word outside this list.
 */
export const AD_OLAMAZ = Object.freeze([
  'ses',
  'sesi',
  'sesini',
  'muzik',
  'muzigi',
  'sarki',
  'sarkiyi',
  'parca',
  'parcayi',
  'bunu',
  'onu',
  'bu',
  'o',
  'listeyi',
  'liste',
  'kuyrugu',
  'sonraki',
  'siradaki',
  'onceki',
  'devam',
  'geri',
  'tekrar',
  'sonra',
  'daha',
  'hepsini',
  'birini',
  'baska',
  'yeni',
  'eski',
  'guzel',
  'cok',
  'iyi',
  'kotu',
  'radyo',
  'oyunu',
  'oyun',
  'kamerayi',
  'mikrofonu',
  'kapiyi',
  'pencereyi',
  'isigi',
  'yayini',
  'discordu',
  'kanali',
]);

const SARKI = 'sarki|sarkiyi|sarkiya|muzik|muzigi|muzige|parca|parcayi|parcaya|bunu|bu|onu';

/** Intents in priority order. The first non-backup intent that matches the whole sentence wins. */
export const KALIPLAR = Object.freeze([
  // ---------------------------------------------------------------- information (no state change)
  {
    niyet: 'bilgi-calan',
    kaliplar: [
      'calan [sarki|parca] ne|hangisi',
      'su an ne caliyor',
      'ne caliyor',
      'bu [sarkinin|parcanin] adi ne',
      'bu ne sarkisi',
      'bu ne sarki',
      'hangi sarki bu',
      'bu hangi parca',
      'bu parca ne',
      'bu kimin sarkisi',
      '[bu] sarkiyi kim soyluyor',
      'sarkinin adini soyle',
      'bu hangi sarki',
      'hangi sarki caliyor',
      'sarkinin adi ne',
      'bu sarki ne',
    ],
    ornekler: ['çalan şarkı ne', 'bu şarkının adı ne', 'şu an ne çalıyor', 'bu hangi şarkı', 'ne çalıyor'],
  },
  {
    niyet: 'bilgi-sira',
    kaliplar: [
      'sirada ne var',
      'siradaki [sarki] ne',
      'sonraki [sarki] ne',
      'kuyrukta ne var',
      'sirada hangi sarkilar var',
      'sonra ne calacak',
      'siradaki|sonraki ne',
      'siradaki|sonraki parca ne',
      'sirada hangi sarki var',
      'sonra hangi sarki gelecek|calacak',
      'kuyrukta hangi sarkilar var',
    ],
    ornekler: ['sırada ne var', 'sıradaki şarkı ne', 'kuyrukta ne var', 'sonraki şarkı ne', 'sonra ne çalacak'],
  },
  {
    niyet: 'bilgi-sayi',
    kaliplar: [
      'kac sarki var',
      'sirada kac sarki var',
      'kuyrukta kac sarki var',
      'kac sarki kaldi',
      'listede kac sarki var',
    ],
    ornekler: [
      'kaç şarkı var',
      'sırada kaç şarkı var',
      'kuyrukta kaç şarkı var',
      'kaç şarkı kaldı',
      'listede kaç şarkı var',
    ],
  },
  // ---------------------------------------------------------------- volume
  {
    niyet: 'ses-ayarla',
    kaliplar: [
      'sesi|ses [yuzde] {sayi} yap|olsun|ayarla',
      'sesi|ses [yuzde] {sayi}',
      'sesi|ses [yuzde] {sayi} [e|a|ye|ya] getir|indir|cikar|dusur|ayarla|cek|al|yukselt|artir',
    ],
    ornekler: ['sesi yüzde elli yap', 'sesi 30 yap', 'ses 80 olsun', 'sesi %40 yap', 'sesi yetmişe ayarla'],
  },
  {
    niyet: 'ses-tam',
    kaliplar: [
      'sesi|sesini sonuna kadar ac',
      'sesi|sesini fulle',
      'sesi|sesini en yuksege cikar',
      'sesi|sesini sonuna kadar artir',
      'sesi|sesini tamamen ac|artir|yukselt',
      'sesi|sesini maksimuma cikar|getir|al|ayarla',
      'sesi|sesini sonuna getir|al|cek|dayat',
      'sesi|sesini sonuna kadar yukselt|cikar',
      'sesi|sesini full yap|et|cek|ac',
    ],
    ornekler: [
      'sesi sonuna kadar aç',
      'sesi fulle',
      'sesi en yükseğe çıkar',
      'sesi sonuna kadar artır',
      'sesi tamamen aç',
    ],
  },
  {
    niyet: 'ses-kis',
    kaliplar: [
      'sesi|sesini|ses kis|kiz|azalt|dusur|alcalt|indir',
      'sesi|sesini kisar|azaltir|dusurur|kisabilir|azaltabilir|dusurebilir',
      'kis',
      'cok|fazla yuksek',
      'sesin|ses cok|fazla yuksek',
      'sesi|sesini asagi al|cek|indir',
    ],
    ornekler: ['sesi kıs', 'sesi biraz kıs', 'sesi azalt', 'sesi düşür', 'çok yüksek'],
  },
  {
    niyet: 'ses-ac',
    kaliplar: [
      'sesi|sesini|ses ac|artir|arttir|yukselt|buyut',
      'sesi|sesini acar|artirir|yukseltir|acabilir|artirabilir|yukseltebilir',
      'sesi|sesini yukari al|cek',
      'cok|fazla kisik|dusuk',
      'sesin|ses cok|fazla kisik|dusuk',
      'duyamiyorum|duyulmuyor',
    ],
    ornekler: ['sesi aç', 'sesi biraz aç', 'sesi artır', 'sesi yükselt', 'çok kısık'],
  },
  // "ses" together with "kapat"/"kes" is always about the volume, never "kapat" (clear the queue).
  {
    niyet: 'sessiz',
    kaliplar: [
      'sesi|sesini|ses kapat|kes|sustur|sifirla|kapa|kapatsana|kessene',
      'sesi|sesini tamamen kapat|kes|kis|sustur|sifirla',
      'sesi|sesini sifir|sifira|sifire yap|cek|indir|al',
      'sessize al|alsana',
      'sesi|sesini sessize al|alsana',
      'sesi|sesini sessiz yap|et',
    ],
    ornekler: ['sesi kapat', 'sesi kes', 'sesi sustur', 'sessize al', 'sesi sıfırla', 'sesi tamamen kıs'],
  },
  {
    niyet: 'sesi-geri-ac',
    kaliplar: [
      'sesi|sesini geri ac|ver|getir',
      'sesi|sesini ac geri',
      'sesi|sesini tekrar ac|ver|getir',
      'sesi|sesini eski haline|seviyesine|seviyeye getir|dondur|al',
      'sessizden cikar|cik|cikart|al',
      'sessizligi|sessizi kapat|kaldir|bitir',
      'sessiz modu kapat|kaldir|bitir',
    ],
    ornekler: ['sesi geri aç', 'sesi aç geri', 'sessizden çıkar', 'sesi tekrar aç', 'sesi eski haline getir'],
  },
  // ---------------------------------------------------------------- seeking
  {
    // Without a duration ("ileri al", "biraz ileri sar") it is the default step (SARMA_ADIMI).
    niyet: 'sar-ileri',
    kaliplar: [
      '{sure} ileri|ileriye|one [sar|al|git|atla|at|gec|ilerlet]',
      '{sure} ilerlet',
      'ileri|ileriye|one sar|al|git|atla|at|gec|ilerlet {sure}',
      'ilerlet {sure}',
      'ileri|ileriye|one sar|al|git|atla|at|gec|ilerlet',
      'ilerlet',
    ],
    ornekler: [
      'otuz saniye ileri sar',
      '10 saniye ileri al',
      'bir dakika ileri git',
      'yarım dakika ileri sar',
      'ileri sar 20 saniye',
      'on saniyelik ileri',
      'ileri at',
      'öne al',
    ],
  },
  {
    // "geri dön" and "geri al" alone are "önceki şarkı"; with a duration they seek back.
    niyet: 'sar-geri',
    kaliplar: [
      '{sure} geri|geriye [sar|al|git|don|at|gec]',
      'geri|geriye sar|al|git|don|at|gec {sure}',
      'geri|geriye sar|git',
      'geriye al',
    ],
    ornekler: [
      '1 dakika geri al',
      'on saniye geri sar',
      'yarım dakika geri git',
      'otuz saniye geriye sar',
      'geri sar 15 saniye',
      'geri git',
      'geriye al',
    ],
  },
  {
    niyet: 'sar-konum',
    kaliplar: ['{konum} git|al|sar|gec|atla|cek'],
    ornekler: [
      '1 dakika 30 saniyeye git',
      "2:30'a al",
      'ikinci dakikaya git',
      'otuz saniyeye git',
      'üçüncü dakikaya sar',
    ],
  },
  {
    niyet: 'basa-sar',
    kaliplar: [
      'basa sar|al|don',
      'bastan al|basla|cal|baslat',
      '[sarkiyi|parcayi|bunu] bastan baslat|al|cal|basla',
      'en basa don|sar|al',
      '[sarkiyi|parcayi|bunu] basa sar|al',
      '[sarkiyi|parcayi|bunu] bastan oynat',
      'en bastan baslat|cal|oynat',
      '[sarkiyi|parcayi|bunu] yeniden baslat|cal|oynat',
      '[sarkiyi|parcayi|bunu] sifirdan baslat|cal|oynat',
    ],
    ornekler: ['başa sar', 'baştan al', 'şarkıyı baştan başlat', 'en başa dön', 'baştan çal'],
  },
  // ---------------------------------------------------------------- queue position
  {
    niyet: 'siraya-atla',
    kaliplar: [
      '{sira} [sarki|sarkiya|sarkiyi] gec|atla|cal|ac',
      'siradaki {sira} [sarki|sarkiya|sarkiyi] gec|atla|cal|ac',
      '{sira} [sarkiya|siraya] gec|atla',
      'sirada|kuyrukta [ki] {sira} [sarkiyi|sarkiya] cal|gec',
    ],
    ornekler: [
      'üçüncü şarkıya geç',
      'sıradaki 2. şarkıyı çal',
      'ikinci şarkıyı çal',
      'dördüncüye atla',
      '5. şarkıya geç',
    ],
  },
  // ---------------------------------------------------------------- transport
  {
    niyet: 'gec',
    kaliplar: [
      'gec|gecsene|atla|atlasana|geciver|atlayiver',
      `[bu|o] ${SARKI} gec|atla`,
      'sonraki|siradaki [sarki|sarkiya|parca|parcaya]',
      'sonrakine|siradakine gec|atla',
      'sonraki|siradaki sarkiya|parcaya gec',
      'pas gec',
      'baska sarki|parca [ac|cal|koy|oynat]',
      'baskasini|baskasi cal|ac|koy|oynat',
      'sonrakini|siradakini cal|ac|oynat',
      `[bu|o] ${SARKI} degistir`,
      'sarkiyi|parcayi degistir',
      'bunu sevmedim [gec]',
      'bir sonraki [sarki|sarkiya] [gec]',
      'diger sarkiya gec',
    ],
    ornekler: [
      'geç',
      'atla',
      'sonraki şarkı',
      'bir sonraki şarkı',
      'pas geç',
      'bunu geç',
      'şu şarkıyı geç',
      'başka şarkı',
    ],
  },
  {
    niyet: 'onceki',
    kaliplar: [
      'onceki [sarki|sarkiya|parca]',
      'oncekine don|gec',
      'onceki sarkiya don|gec',
      'geri don',
      'geri al',
      'bir onceki [sarki|sarkiya] [don|gec]',
      'onceki sarkiyi|parcayi [tekrar] cal|ac|oynat',
      'oncekini cal|ac|oynat',
    ],
    ornekler: ['önceki şarkı', 'geri dön', 'öncekine dön', 'bir önceki şarkı', 'önceki şarkıyı çal'],
  },
  {
    // Clears the queue and cuts what is playing (the bot stays in the channel). Irreversible, so only explicit
    // phrasings: "durdur", "sus", "kes" and "yeter" are NOT here, they pause.
    niyet: 'kapat',
    kaliplar: [
      'kapat|kapatsana|bitir',
      `[bu|o] ${SARKI} kapat|bitir`,
      'muzigi|sarkiyi tamamen kapat|bitir',
      'kuyrugu|sirayi|listeyi temizle',
      'calma',
      'cal ma',
    ],
    ornekler: ['müziği kapat', 'kapat', 'müziği bitir', 'kuyruğu temizle', 'listeyi temizle'],
  },
  {
    niyet: 'duraklat',
    kaliplar: [
      'durdur|durdursana|duraklat|durakla|duraklar|beklet|bekle|dur',
      'sus|sussana|kes|kessene|yeter',
      `[bu|o] ${SARKI} durdur|duraklat|beklet|dondur|kes`,
      'bir saniye dur',
      'ara ver',
      'mola [ver]',
      'dondur',
      'pause [et]',
    ],
    ornekler: [
      'durdur',
      'müziği durdur',
      'şarkıyı durdur',
      'bekle',
      'bi dur',
      'sus',
      'kes',
      'müziği kes',
      'bi sus',
      'yeter',
    ],
  },
  {
    niyet: 'devam',
    kaliplar: [
      'devam [et|ettir]',
      'surdur',
      `[bu|o] ${SARKI} [devam] ettir|surdur`,
      'muzigi|sarkiyi ac',
      'kaldigin|kaldigi yerden devam [et|ettir]',
      'kaldigin|kaldigi yerden surdur|baslat|cal|oynat',
      'sarkiya|muzige devam [et|ettir]',
      'muzigi|sarkiyi surdur|baslat|oynat',
      'devam edelim',
      'tekrar baslat',
      'resume',
    ],
    ornekler: ['devam et', 'sürdür', 'müziği aç', 'kaldığın yerden devam et', 'devam ettir'],
  },
  // ---------------------------------------------------------------- modes
  {
    niyet: 'tekrar-liste',
    kaliplar: [
      'listeyi|kuyrugu|sirayi tekrarla',
      'listeyi|kuyrugu|sirayi tekrar et',
      'listeyi|kuyrugu|sirayi donguye al',
      'liste|kuyruk dongusu [ac]',
    ],
    ornekler: ['listeyi tekrarla', 'kuyruğu tekrarla', 'sırayı döngüye al', 'listeyi döngüye al', 'kuyruk döngüsü aç'],
  },
  {
    niyet: 'dongu-kapat',
    kaliplar: [
      'donguyu|tekrari|tekrarlamayi kapat|kaldir|birak',
      'donguyu|tekrari|tekrarlamayi iptal et',
      'tekrarlama',
      'tekrarlamayi durdur',
      'dongu kapat',
    ],
    ornekler: ['döngüyü kapat', 'tekrarı kapat', 'tekrarlamayı bırak', 'döngüyü kaldır', 'tekrarlama'],
  },
  {
    niyet: 'tekrarla',
    kaliplar: [
      'tekrarla',
      'tekrar et',
      `[bu|o] ${SARKI} tekrarla`,
      `[bu|o] ${SARKI} tekrar et`,
      `[${SARKI}] donguye al`,
      'bir daha cal|oynat',
      `[bu|o] ${SARKI} bir daha|daha cal|oynat|dinle`,
      `[bu|o] ${SARKI} tekrar cal|oynat`,
      'ayni sarkiyi|parcayi cal|oynat|tekrar cal',
      'tekrar cal|oynat',
    ],
    ornekler: ['tekrarla', 'döngüye al', 'bu şarkıyı tekrarla', 'tekrar et', 'bir daha çal'],
  },
  {
    niyet: 'karistir',
    kaliplar: [
      'karistir|karistirsana|karistirir',
      'listeyi|kuyrugu|sirayi|sarkilari karistir',
      'karisik cal|oynat|sirala',
      'rastgele cal|oynat|sirala|yap',
      'listeyi|kuyrugu|sirayi|sarkilari rastgele cal|oynat|sirala|yap',
      'sirayi kar',
      'shuffle',
    ],
    ornekler: ['karıştır', 'listeyi karıştır', 'sırayı karıştır', 'karışık çal', 'rastgele çal'],
  },
  {
    niyet: 'otomatik-ac',
    kaliplar: ['otomatik calmayi|cal|calma ac', 'otomatik calmayi baslat', 'otomatik [calma] acik', 'otomatik calsin'],
    ornekler: [
      'otomatik çalmayı aç',
      'otomatik çal aç',
      'otomatik çalmayı başlat',
      'otomatik çalsın',
      'otomatik çalma açık',
    ],
  },
  {
    niyet: 'otomatik-kapat',
    kaliplar: ['otomatik calmayi|cal|calma kapat|durdur|kaldir', 'otomatik [calma] kapali', 'otomatik calmasin'],
    ornekler: [
      'otomatik çalmayı kapat',
      'otomatik çal kapat',
      'otomatik çalmayı durdur',
      'otomatik çalmasın',
      'otomatik kapalı',
    ],
  },
  // ---------------------------------------------------------------- adding music
  {
    niyet: 'liste-cal',
    kaliplar: [
      '{ad} listemi|listesini|listeyi|listem cal|ac|oynat|baslat',
      '{ad} adli listeyi cal|ac',
      'listem {ad} cal|ac',
    ],
    ornekler: [
      'gece listemi çal',
      'oyun listesini aç',
      'sabah listesini çal',
      'gece adlı listeyi aç',
      'parti listemi başlat',
    ],
  },
  {
    niyet: 'kuyruga-ekle',
    kaliplar: [
      'kuyruga|siraya|listeye|sona {sorgu} ekle',
      '{sorgu} kuyruga|siraya|sona ekle',
      '{sorgu} ekle',
      'siraya {sorgu} koy|at',
      '{sorgu} siraya|kuyruga koy|at',
    ],
    ornekler: [
      'kuyruğa Tarkan ekle',
      "Sezen Aksu'yu sıraya ekle",
      'sıraya Barış Manço koy',
      'Tarkan dudu ekle',
      "Duman'ı kuyruğa at",
    ],
  },
  {
    niyet: 'hemen-cal',
    kaliplar: [
      'hemen|simdi|direkt {sorgu} ac|cal|oynat|koy',
      '{sorgu} hemen|simdi ac|cal|oynat',
      'siradaki olarak {sorgu} cal|ac|ekle',
    ],
    ornekler: [
      'hemen Tarkan çal',
      'şimdi dudu aç',
      "Sezen Aksu'yu hemen çal",
      'direkt Duman aç',
      'sıradaki olarak Tarkan çal',
    ],
  },
  {
    niyet: 'cal',
    yedek: true,
    kaliplar: [
      '{sorgu} ac|acar|acsana|acin|acabilir|acarmisin|cal|calar|calsana|calin|calabilir|calarmisin|calistir|oynat|oynatir|oynatsana|koy|koyar|koysana|baslat',
      'cal|ac|oynat {sorgu}',
    ],
    ornekler: [
      'Tarkan dudu dudu aç',
      'Sezen Aksu gülümse çal',
      'Barış Manço çalar mısın',
      'bir Tarkan koy',
      'çal Duman',
    ],
  },
]);
