# wboot-relay

NAT arkasindaki boot-recovery cihazlarina, WebSocket uzerinden cok-servisli
(SSH / Telnet / VNC / RDP) erisim saglayan hafif bir relay sunucusu.
Render.com free tier'da calisir - hicbir ozel TCP portu gerektirmez, sadece
standart HTTPS (443) uzerinden WebSocket.

## Nasil calisir

```
Cihaz (recovery mod)                RELAY                 Teknik ekip
  device_bridge  --wss://.../device/<id>/<port>--> [] <--wss://.../client/<id>/<port>--  ws_proxy
                 --wss://.../device/<id>/control-> []
```

Relay, ayni `<id>` ve `<port>` ile gelen device ve client baglantilarini
birbirine baglar (kor boru - icerigi gormez). SSH'in kendi sifrelemesi ve
host-key dogrulamasi uctan uca calismaya devam eder; relay sadece byte tasir.

### Endpoint'ler

| Yol | Aciklama |
|---|---|
| `wss://<host>/device/<id>/<port>` | Cihazin belirli bir servis icin bagli oldugu taraf |
| `wss://<host>/device/<id>/control` | Cihazin kontrol kanali (her zaman acik) |
| `wss://<host>/client/<id>/<port>` | Teknik ekibin erisim tarafi |
| `https://<host>/health` | Durum bilgisi (JSON) |

Desteklenen portlar: **22** (SSH), **23** (Telnet), **5900** (VNC), **3389** (RDP).

### Daima-acik ve talep-aninda portlar

- **Daima-acik (22, 23):** cihaz relay'e baglandigi an bu portlar icin WS
  baglantisini hemen acar ve acik tutar. Client geldiginde device soketi
  zaten hazirdir. Bu portlar eskime temizliginden muaftir.
- **Talep-aninda (5900, 3389):** cihaz onceden baglanmaz. Client bu portlardan
  birine gelirse relay, cihazin control kanalina `connect-request` yollar;
  cihaz o porta yeni bir WS acmayi dener. Cihaz portu acamazsa (servis kapali)
  client'a JSON hata mesaji gonderilip baglanti kapatilir.

### Kontrol duzlemi mesajlari

Control kanali uzerinden, JSON olarak (relay -> cihaz):

```json
{"type": "connect-request",  "port": 5900}
{"type": "client-connected", "port": 23}
```

`client-connected`, kopru kuruldugu an gonderilir. **Sunucu-once konusan
protokoller icin sarttir:** Telnet (IAC negotiation) ve VNC (RFB) ilk bayti
sunucu gonderir, dolayisiyla cihaz yerel servise ilk bayti bekleyerek degil,
bu sinyalle baglanmalidir.

### Kapanis kodlari

| Kod | Anlami |
|---|---|
| `4404` | Cihaz bagli degil (daima-acik portta bekleyen device soketi yok) |
| `4409` | Port mesgul: zaten aktif bir oturum ya da bekleyen bir talep var |
| `4503` | Hata (`device_offline`, `connect_timeout`, `control_channel_error`) |
| `1009` | Frame `RELAY_MAX_PAYLOAD` sinirini asti |

## Kullanim

### Cihaz tarafi

```bash
RELAY_DEVICE_TOKEN=<token> node device_bridge.js <device_id>
```

### Teknik ekip tarafi

```bash
# SSH (port varsayilani 22)
RELAY_CLIENT_TOKEN=<token> \
  ssh -o ProxyCommand="node ws_proxy.js <device_id>" srv@dummy

# Baska bir servis
RELAY_CLIENT_TOKEN=<token> node ws_proxy.js <device_id> 5900
```

`ws_proxy.js`, relay'in JSON hata mesajlarini **stderr**'e ayirir; stdout
yalnizca ham tunel trafigini tasir, boylece SSH akisi bozulmaz.

## Dosya duzeni

```
server.js           relay sunucusu
device_bridge.js    cihaz tarafi kopru yazilimi (remote.c'nin Node taklidi)
ws_proxy.js         teknik ekip tarafi - ssh ProxyCommand'i
test/               test ve elle deneme scriptleri
```

## Yerel test

```bash
npm install
npm test                     # 24 testlik protokol paketi (kendi sunucusunu baslatir)
```

`npm test` bagimsizdir: kendi sunucu orneklerini baslatir, sifir yapilandirma
ister, hata durumunda sifirdan farkli exit kodu doner.

`test/` altindaki digerleri, calisan bir relay'e karsi elle calistirilir.
Hepsi `RELAY_URL` (veya `RELAY_HOST`) ve token ortam degiskenlerini kabul eder:

| Script | Ne yapar | Cihaz gerektirir mi |
|---|---|---|
| `test/relay.test.js` | Tam protokol paketi (`npm test`) | Hayir |
| `test/bridge.js` | Temel kopruleme, iki yonlu veri | Hayir |
| `test/bridge_render.js` | Ayni senaryo, uzak Render ornegine karsi (uzun zaman asimlari) | Hayir |
| `test/invalid_ids.js` | Gecersiz id / port / yol reddi | Hayir |
| `test/no_device.js` | Cihaz yokken client davranisi (4404, `device_offline`) | Hayir |
| `test/multi_port.js` | Tum portlarin gercek cihaza karsi davranisi | **Evet** |
| `test/device_bridge.js` | Tek portluk sade cihaz taklidi (sorun ayiklama icin) | — |

Elle uctan uca denemek icin uc terminal:

```bash
# 1
PORT=3999 node server.js

# 2
RELAY_URL=ws://localhost:3999 node device_bridge.js test-device-abc123

# 3
RELAY_URL=ws://localhost:3999 \
  ssh -o ProxyCommand="node ws_proxy.js test-device-abc123" srv@dummy

# ya da tum portlarin durumunu gormek icin:
RELAY_URL=ws://localhost:3999 node test/multi_port.js test-device-abc123
```

`test/multi_port.js` ornek ciktisi (yerel makinede yalnizca SSH acikken):

```
SSH-22       daima-acik     SERVIS CALISIYOR (33 B tasindi)
Telnet-23    daima-acik     kopru kuruldu, veri akmadi
VNC-5900     talep-aninda   hata: connect_timeout
RDP-3389     talep-aninda   hata: connect_timeout
```

Kapali servisler icin `connect_timeout` beklenen ve dogru davranistir.

## Yapilandirma

Hepsi opsiyonel; parantez icindekiler varsayilan degerlerdir.

| Degisken | Aciklama |
|---|---|
| `PORT` | Dinlenecek port (`3000`) |
| `RELAY_DEVICE_TOKEN` | Cihaz tarafi paylasilan sir (bos = **dogrulama kapali**) |
| `RELAY_CLIENT_TOKEN` | Client tarafi paylasilan sir (bos = **dogrulama kapali**) |
| `RELAY_MAX_PAYLOAD` | Tek WS frame ust siniri, bayt (`1048576`) |
| `RELAY_CONNECT_TIMEOUT_MS` | Cihazin `connect-request`'e cevap suresi (`15000`) |
| `RELAY_ON_DEMAND_STALE_MS` | Cevapsiz talep-aninda soketlerin temizlenme suresi (`120000`) |
| `RELAY_HEARTBEAT_MS` | Ping araligi (`30000`) |
| `RELAY_HEARTBEAT_MAX_MISSED` | Kac cevapsiz pingten sonra baglanti koparilir (`2`) |
| `RELAY_PREBRIDGE_BUFFER` | Kopru oncesi tamponlanacak azami veri, bayt (`262144`) |
| `RELAY_BACKPRESSURE_HIGH` / `_LOW` | Backpressure esikleri, bayt (`1048576` / `262144`) |
| `RELAY_MAX_SOCKETS` | Toplam es zamanli soket siniri (`500`) |
| `RELAY_MAX_DEVICES` | Bellekte tutulacak azami cihaz sayisi (`1000`) |
| `RELAY_MAX_SOCKETS_PER_IP` | IP basina soket siniri (`20`) |
| `RELAY_ALLOW_BROWSER_ORIGINS` | `1` ise `Origin` basligi tasiyan baglantilara izin ver |

Cihaz ve client tarafinda ayrica `RELAY_URL` (tam taban URL, orn.
`ws://localhost:3999`) veya `RELAY_HOST` (yalnizca host adi) kullanilir.

### Token uretme

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Token, `Authorization: Bearer <token>` basligi, `X-Relay-Token` basligi ya da
`?token=` sorgu parametresi ile gonderilebilir. Karsilastirma sabit zamanlidir
(SHA-256 + `timingSafeEqual`).

## Render.com'a deploy

1. Bu repoyu GitHub'a push et.
2. Render.com > New > Web Service > repoyu sec.
3. Ayarlar:
   - **Language**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. **Environment** sekmesinde `RELAY_DEVICE_TOKEN` ve `RELAY_CLIENT_TOKEN`
   tanimla. Bunlar bos birakilirsa sunucu baslangicta uyari loglar ve
   kimlik dogrulamasi yapmadan calisir.
5. Deploy et. Render `https://<servis-adi>.onrender.com` adresi verir;
   WebSocket icin `wss://<servis-adi>.onrender.com/device/<id>/<port>`.

Relay `SIGTERM` aldiginda acik soketleri `1001` ile duzgunce kapatir, yani
Render deploy'lari sirasinda cihazlar temiz bir yeniden baglanma yasar.

## Onemli: Render free tier uyku modu

Free tier 15 dakika trafik olmayinca uykuya dalar, ilk istek 30-60 saniye
gecikebilir. Cihaz nadiren (yillar arayla) baglanacagi icin bu durum onemli:

- **Cozum**: UptimeRobot (ucretsiz) veya cron-job.org gibi bir servisle
  `/health` endpoint'ine her 10 dakikada bir ping attirarak sunucuyu uyanik
  tutabilirsiniz. Bu, Render'in kurallarina aykiri degildir.
- Alternatif olarak, arizali cihazin ilk baglanti denemesinde 30-60 saniyelik
  gecikmeyi kabul edilebilir sayabilirsiniz.

Not: relay'in kendi ping/pong heartbeat'i (varsayilan 30 sn) **kurulmus**
baglantilarin idle timeout ile dusmesini engeller. Bu, eskiden gorulen
`code=1006` kopmalarinin cozumudur. Ancak hic baglanti yokken sunucunun
uykuya dalmasini engellemez - onun icin yukaridaki harici ping gerekir.

## Guvenlik notlari

- **Kimlik dogrulama**: `RELAY_DEVICE_TOKEN` / `RELAY_CLIENT_TOKEN` tanimlayin.
  Token olmadan, device ID'yi bilen herkes cihaz gibi davranabilir. SSH'in
  host-key dogrulamasi bunu yakalar, ancak **Telnet, VNC ve RDP'nin boyle bir
  korumasi yoktur** - bu servisler kullanilacaksa token zorunlu sayilmalidir.
- Device ID en az 8 karakter, sadece alfanumerik + tire/altcizgi olmali
  (`safeDeviceId` bunu zorunlu kilar). Tahmin edilebilir ID kullanmayin:
  `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
- Relay, trafigin icerigini hic gormez - gercek guvenlik SSH'in kendi
  katmanindadir (host key + kullanici kimlik dogrulama).
- Ayni ID ve port ile ikinci bir cihaz baglanirsa, oncekinin baglantisi
  kapatilir (tek cihaz - tek oturum kurali). Aktif bir oturum varken gelen
  ikinci client `4409` ile reddedilir.
- `Origin` basligi tasiyan baglantilar varsayilan olarak reddedilir
  (tarayici kaynakli CSWSH saldirilarina karsi). Mesru istemciler bu basligi
  gondermez.
- Frame boyutu, soket sayisi, cihaz sayisi ve IP basina baglanti sayisi
  sinirlandirilmistir; asilan sinirlar HTTP 429/503 ile reddedilir.
