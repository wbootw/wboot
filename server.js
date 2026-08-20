/**
 * server.js
 *
 * wboot-relay: WebSocket tabanli, NAT arkasindaki boot-recovery cihazlarina
 * disaridan SSH erisimi saglayan koprulayici sunucu.
 *
 * Mimarideki rolu: SADECE bir "kor boru". Icinden gecen SSH trafiginin
 * icerigini gormez, deşifre etmez, sakla-mez. Iki WebSocket baglantisini
 * (device <-> client) birbirine ham byte seviyesinde bagliyor.
 *
 * Endpoint'ler:
 *   wss://<host>/device/<device_id>   - cihazin baglandigi taraf
 *   wss://<host>/client/<device_id>   - teknik ekibin baglandigi taraf
 *
 * Ayni device_id ile HEM device HEM client baglaninca kopru kurulur.
 * Ikinci bir device ayni ID ile baglanmaya calisirsa eskisi reddedilir
 * (tek cihaz - tek aktif oturum).
 *
 * DB YOK, DISK YOK - her sey bellekte (Map). Render'in ucretsiz plani
 * icin bu ideal: process yeniden baslarsa zaten aktif oturum kalmaz,
 * kayip veri de olmaz cunku hicbir sey disariya yazilmiyor.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Bekleyen cihazlar: device_id -> { ws, connectedAt }
const pendingDevices = new Map();

// Aktif kopruler (log/istatistik icin, opsiyonel): device_id -> { deviceWs, clientWs, startedAt }
const activeBridges = new Map();

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function safeDeviceId(id) {
    // Path'ten gelen ID'yi sanitize et - sadece alfanumerik + tire/altçizgi.
    return /^[a-zA-Z0-9_-]{8,128}$/.test(id) ? id : null;
}

const server = http.createServer((req, res) => {
    // Render'in health check'i ve tarayicidan yanlislikla HTTP GET gelirse
    // basit bir durum sayfasi donelim.
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            pending_devices: pendingDevices.size,
            active_bridges: activeBridges.size,
        }));
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean); // ["device", "<id>"] veya ["client", "<id>"]

    if (parts.length !== 2 || !['device', 'client'].includes(parts[0])) {
        socket.destroy();
        return;
    }

    const role = parts[0];
    const deviceId = safeDeviceId(parts[1]);

    if (!deviceId) {
        log(`REDDEDILDI: gecersiz device_id formati (${parts[1]})`);
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (role === 'device') {
            handleDeviceConnection(ws, deviceId);
        } else {
            handleClientConnection(ws, deviceId);
        }
    });
});

function handleDeviceConnection(ws, deviceId) {
    // Ayni ID ile eski bir bekleyen baglanti varsa temizle (cihaz yeniden
    // baglanmis olabilir - orn. kisa kesinti sonrasi reconnect).
    const existing = pendingDevices.get(deviceId);
    if (existing) {
        log(`Cihaz ${deviceId} yeniden baglandi, eski bekleyen baglanti kapatiliyor`);
        try { existing.ws.close(); } catch (_) {}
    }

    // Zaten aktif bir bridge varsa (cihaz zaten birine bagliyken tekrar
    // geldi) - bu normalde olmamali ama guvenlik icin eski bridge'i kapat.
    const existingBridge = activeBridges.get(deviceId);
    if (existingBridge) {
        log(`Cihaz ${deviceId} aktif bridge varken tekrar baglandi, eski bridge kapatiliyor`);
        try { existingBridge.deviceWs.close(); } catch (_) {}
        try { existingBridge.clientWs.close(); } catch (_) {}
        activeBridges.delete(deviceId);
    }

    pendingDevices.set(deviceId, { ws, connectedAt: Date.now() });
    log(`Cihaz bekliyor: ${deviceId} (toplam bekleyen: ${pendingDevices.size})`);

    ws.on('close', () => {
        // Sadece hala bekleme listesindeyse temizle (bridge kurulduysa
        // zaten oradan silinmis olur, burada tekrar silmeye calismak
        // zararsiz ama gereksiz).
        if (pendingDevices.get(deviceId)?.ws === ws) {
            pendingDevices.delete(deviceId);
            log(`Cihaz baglantisi kapandi (bekleme listesinden cikti): ${deviceId}`);
        }
    });

    ws.on('error', (err) => {
        log(`Cihaz WS hatasi (${deviceId}): ${err.message}`);
    });
}

function handleClientConnection(ws, deviceId) {
    const pending = pendingDevices.get(deviceId);

    if (!pending) {
        log(`REDDEDILDI: client, bekleyen cihaz olmadan baglanmaya calisti (${deviceId})`);
        ws.close(4404, 'device not connected');
        return;
    }

    // Cihazi bekleme listesinden cikar, bridge'e tasi.
    pendingDevices.delete(deviceId);
    const deviceWs = pending.ws;

    bridgeConnections(deviceId, deviceWs, ws);
}

function bridgeConnections(deviceId, deviceWs, clientWs) {
    log(`KOPRU KURULDU: ${deviceId}`);
    activeBridges.set(deviceId, { deviceWs, clientWs, startedAt: Date.now() });

    // Ham byte akisini iki yonlu kopyala. WebSocket mesajlari binary
    // olarak gelir (SSH trafigi TCP-native binary bir protokol),
    // bu yuzden 'message' event'inde aldigimizi degistirmeden karsi
    // tarafa gonderiyoruz.
    deviceWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === clientWs.OPEN) {
            clientWs.send(data, { binary: isBinary });
        }
    });

    clientWs.on('message', (data, isBinary) => {
        if (deviceWs.readyState === deviceWs.OPEN) {
            deviceWs.send(data, { binary: isBinary });
        }
    });

    const cleanup = (reason) => {
        if (activeBridges.get(deviceId)?.deviceWs === deviceWs) {
            activeBridges.delete(deviceId);
            log(`KOPRU KAPANDI: ${deviceId} (${reason})`);
        }
        try { deviceWs.close(); } catch (_) {}
        try { clientWs.close(); } catch (_) {}
    };

    deviceWs.on('close', () => cleanup('cihaz baglantisi kapandi'));
    clientWs.on('close', () => cleanup('client baglantisi kapandi'));
    deviceWs.on('error', (err) => cleanup(`cihaz hatasi: ${err.message}`));
    clientWs.on('error', (err) => cleanup(`client hatasi: ${err.message}`));
}

// Bekleyen cihazlar cok uzun sure kimse baglanmadan beklerse (orn. 10 dakika)
// baglantiyi kapatalim - kaynak sizintisini onlemek icin. Bu, cihazin
// supervisor loop'u tarafindan zaten yeniden denenecek.
const STALE_TIMEOUT_MS = 10 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [id, info] of pendingDevices.entries()) {
        if (now - info.connectedAt > STALE_TIMEOUT_MS) {
            log(`ESKIMIS BEKLEME TEMIZLENDI: ${id}`);
            try { info.ws.close(); } catch (_) {}
            pendingDevices.delete(id);
        }
    }
}, 60 * 1000);

server.listen(PORT, () => {
    log(`wboot-relay dinliyor: port ${PORT}`);
});
