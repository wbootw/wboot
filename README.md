# wboot-relay

NAT arkasindaki boot-recovery cihazlarina, WebSocket uzerinden SSH erisimi
saglayan hafif bir relay sunucusu. Render.com free tier'da calisir - hicbir
ozel TCP portu gerektirmez, sadece standart HTTPS (443) uzerinden WebSocket.

## Nasil calisir

```
Cihaz (recovery mod)  --wss://.../device/<id>-->  RELAY  <--wss://.../client/<id>--  Teknik ekip
```

Relay, ayni `<id>` ile gelen device ve client baglantilarini birbirine
baglar (kor boru - icerigi gormez). SSH'in kendi sifrelemesi ve host-key
dogrulamasi uctan uca calismaya devam eder; relay sadece byte tasir.

- `wss://<host>/device/<id>` - cihazin baglandigi taraf
- `wss://<host>/client/<id>` - teknik ekibin baglandigi taraf

## Yerel test

```bash
npm install
PORT=3999 node server.js
```

Baska bir terminalde:
```bash
node test_bridge.js       # temel koprulama testi
node test_no_device.js    # cihaz olmadan client baglanma testi
node test_invalid_ids.js  # gecersiz ID format testi
```

## Render.com'a deploy

1. Bu repoyu GitHub'a push et.
2. Render.com > New > Web Service > repoyu sec.
3. Ayarlar:
   - **Language**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. Deploy et. Render sana `https://<servis-adi>.onrender.com` adresi verir.
   WebSocket icin `wss://<servis-adi>.onrender.com/device/<id>` seklinde
   kullanilir (Render otomatik TLS sagliyor, `wss://` `https://`nin
   WebSocket karsiligidir).

## Onemli: Render free tier uyku modu

Free tier 15 dakika trafik olmayinca uykuya dalar, ilk istek 30-60 saniye
gecikebilir. Cihaz nadiren (yillar arayla) baglanacagi icin bu durum onemli:

- **Cozum**: UptimeRobot (ucretsiz) veya cron-job.org gibi bir servisle
  `/health` endpoint'ine her 10 dakikada bir ping attirarak sunucuyu
  uyanik tutabilirsiniz. Bu, Render'in kurallarina aykiri degildir.
- Alternatif olarak, arizali cihazin ilk baglanti denemesinde 30-60
  saniyelik gecikmeyi kabul edilebilir olarak degerlendirebilirsiniz -
  zaten cihaz arizali ve mudahale bekliyor durumda.

## Guvenlik notlari

- Device ID en az 8 karakter, sadece alfanumerik + tire/altcizgi olmali
  (server.js'deki `safeDeviceId` fonksiyonu bunu zorunlu kilar).
- Relay, SSH trafiginin icerigini hic gormez - gercek guvenlik SSH'in
  kendi katmaninda (host key + kullanici kimlik dogrulama) saglanir.
- Ayni ID ile ikinci bir cihaz baglanirsa, oncekinin baglantisi kapatilir
  (tek cihaz - tek oturum kurali).
- 10 dakikadan uzun suredir client bekleyen cihaz baglantilari otomatik
  temizlenir (kaynak sizintisini onlemek icin).
