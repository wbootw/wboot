/**
 * server.js
 *
 * wboot-relay: WebSocket tabanli, NAT arkasindaki boot-recovery cihazlarina
 * disaridan cok-servisli erisim saglayan koprulayici sunucu.
 *
 * Mimarideki rolu: SADECE bir "kor boru". Icinden gecen trafigin
 * icerigini gormez, deşifre etmez, sakla-mez. Iki WebSocket baglantisini
 * (device <-> client) birbirine ham byte seviyesinde bagliyor.
 *
 * Endpoint'ler:
 *   wss://<host>/device/<device_id>/<port>   - cihazin belirli bir servis
 *                                              icin bagli oldugu taraf
 *   wss://<host>/device/<device_id>/control  - cihazin kontrol kanali
 *                                              (relay'den "connect-request"
 *                                              bildirimleri buradan gelir)
 *   wss://<host>/client/<device_id>/<port>   - teknik ekibin belirli bir
 *                                              servise erismek istedigi taraf
 *
 * DAIMA-ACIK portlar (ALWAYS_ON_PORTS): cihaz relay'e baglandigi an bu
 * portlar icin WS baglantisini hemen acar (SSH, Telnet). Bu portlara
 * client geldiginde bekleyen device soketi zaten hazirdir.
 *
 * TALEP-ANINDA portlar (VNC, RDP gibi digerleri): cihaz bu portlara
 * onceden baglanmaz. Client bu portlardan birine baglanmaya calisirsa
 * ve bekleyen bir device soketi yoksa, relay device'in control kanalina
 * bir "connect-request" mesaji yollar. Cihaz bunun uzerine o porta yeni
 * bir WS acmayi dener. Basarili olursa normal sekilde bridge kurulur.
 * Cihaz o portu acamazsa (servis kapali/desteklenmiyor), client'a JSON
 * hata mesaji gonderilip baglanti kapatilir.
 *
 * DB YOK, DISK YOK - her sey bellekte (Map).
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const ALLOWED_PORTS = {
    22: 'SSH',
    23: 'Telnet',
    5900: 'VNC',
    3389: 'RDP',
};

const ALWAYS_ON_PORTS = new Set([22, 23]);

const devices = new Map();
const activeBridges = new Map();

const CONNECT_REQUEST_TIMEOUT_MS = 15 * 1000;
const STALE_TIMEOUT_MS = 10 * 60 * 1000;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function safeDeviceId(id) {
    return /^[a-zA-Z0-9_-]{8,128}$/.test(id) ? id : null;
}

function getOrCreateDeviceState(deviceId) {
    let state = devices.get(deviceId);
    if (!state) {
        state = {
            controlWs: null,
            pendingByPort: new Map(),
            pendingConnectRequests: new Map(),
        };
        devices.set(deviceId, state);
    }
    return state;
}

function bridgeKey(deviceId, port) {
    return `${deviceId}:${port}`;
}

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        let pendingCount = 0;
        for (const state of devices.values()) pendingCount += state.pendingByPort.size;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            known_devices: devices.size,
            pending_device_sockets: pendingCount,
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
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length !== 3 || !['device', 'client'].includes(parts[0])) {
        socket.destroy();
        return;
    }

    const role = parts[0];
    const deviceId = safeDeviceId(parts[1]);
    const portToken = parts[2];

    if (!deviceId) {
        log(`REDDEDILDI: gecersiz device_id formati (${parts[1]})`);
        socket.destroy();
        return;
    }

    if (role === 'device' && portToken === 'control') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            handleDeviceControlConnection(ws, deviceId);
        });
        return;
    }

    const port = Number(portToken);
    if (!Number.isInteger(port) || !ALLOWED_PORTS[port]) {
        log(`REDDEDILDI: desteklenmeyen port (${portToken}) - ${deviceId}`);
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (role === 'device') {
            handleDevicePortConnection(ws, deviceId, port);
        } else {
            handleClientConnection(ws, deviceId, port);
        }
    });
});

function handleDeviceControlConnection(ws, deviceId) {
    const state = getOrCreateDeviceState(deviceId);

    if (state.controlWs) {
        log(`Cihaz ${deviceId} icin eski kontrol kanali kapatiliyor (yeniden baglanma)`);
        try { state.controlWs.close(); } catch (_) {}
    }
    state.controlWs = ws;
    log(`Cihaz kontrol kanali baglandi: ${deviceId}`);

    ws.on('close', () => {
        if (state.controlWs === ws) {
            state.controlWs = null;
            log(`Cihaz kontrol kanali kapandi: ${deviceId}`);
        }
    });

    ws.on('error', (err) => {
        log(`Cihaz kontrol kanali hatasi (${deviceId}): ${err.message}`);
    });
}

function handleDevicePortConnection(ws, deviceId, port) {
    const state = getOrCreateDeviceState(deviceId);

    const existingPending = state.pendingByPort.get(port);
    if (existingPending) {
        log(`Cihaz ${deviceId}:${port} yeniden baglandi, eski bekleyen baglanti kapatiliyor`);
        try { existingPending.ws.close(); } catch (_) {}
    }

    const key = bridgeKey(deviceId, port);
    const existingBridge = activeBridges.get(key);
    if (existingBridge) {
        log(`Cihaz ${deviceId}:${port} aktif bridge varken tekrar baglandi, eski bridge kapatiliyor`);
        try { existingBridge.deviceWs.close(); } catch (_) {}
        try { existingBridge.clientWs.close(); } catch (_) {}
        activeBridges.delete(key);
    }

    state.pendingByPort.set(port, { ws, connectedAt: Date.now() });
    log(`Cihaz bekliyor: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);

    const waitingRequest = state.pendingConnectRequests.get(port);
    if (waitingRequest) {
        clearTimeout(waitingRequest.timeoutHandle);
        state.pendingConnectRequests.delete(port);
        state.pendingByPort.delete(port);
        bridgeConnections(deviceId, port, ws, waitingRequest.clientWs);
        return;
    }

    ws.on('close', () => {
        if (state.pendingByPort.get(port)?.ws === ws) {
            state.pendingByPort.delete(port);
            log(`Cihaz baglantisi kapandi (bekleme listesinden cikti): ${deviceId}:${port}`);
        }
    });

    ws.on('error', (err) => {
        log(`Cihaz WS hatasi (${deviceId}:${port}): ${err.message}`);
    });
}

function handleClientConnection(ws, deviceId, port) {
    const state = getOrCreateDeviceState(deviceId);
    const pending = state.pendingByPort.get(port);

    if (pending) {
        state.pendingByPort.delete(port);
        bridgeConnections(deviceId, port, pending.ws, ws);
        return;
    }

    if (ALWAYS_ON_PORTS.has(port)) {
        log(`REDDEDILDI: client, bekleyen cihaz olmadan baglanmaya calisti (${deviceId}:${port})`);
        ws.close(4404, 'device not connected');
        return;
    }

    if (!state.controlWs || state.controlWs.readyState !== state.controlWs.OPEN) {
        log(`REDDEDILDI: cihaz kontrol kanali yok, talep-aninda baglanti kurulamiyor (${deviceId}:${port})`);
        sendJsonError(ws, 'device_offline', `${deviceId} icin cihaz baglantisi (control channel) yok`);
        return;
    }

    log(`TALEP-ANINDA baglanti istendi: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);

    const timeoutHandle = setTimeout(() => {
        state.pendingConnectRequests.delete(port);
        log(`ZAMAN ASIMI: cihaz ${deviceId}:${port} portuna zamaninda baglanmadi`);
        sendJsonError(ws, 'connect_timeout', `Cihaz ${ALLOWED_PORTS[port]} (port ${port}) servisine baglanamadi (zaman asimi)`);
    }, CONNECT_REQUEST_TIMEOUT_MS);

    state.pendingConnectRequests.set(port, { clientWs: ws, timeoutHandle });

    try {
        state.controlWs.send(JSON.stringify({ type: 'connect-request', port }));
    } catch (err) {
        clearTimeout(timeoutHandle);
        state.pendingConnectRequests.delete(port);
        sendJsonError(ws, 'control_channel_error', 'Cihaza istek iletilemedi');
        return;
    }

    ws.on('close', () => {
        const stillWaiting = state.pendingConnectRequests.get(port);
        if (stillWaiting && stillWaiting.clientWs === ws) {
            clearTimeout(stillWaiting.timeoutHandle);
            state.pendingConnectRequests.delete(port);
        }
    });
}

function sendJsonError(ws, code, message) {
    try {
        ws.send(JSON.stringify({ type: 'error', code, message }));
    } catch (_) {}
    try { ws.close(4503, code); } catch (_) {}
}

function bridgeConnections(deviceId, port, deviceWs, clientWs) {
    const key = bridgeKey(deviceId, port);
    log(`KOPRU KURULDU: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);
    activeBridges.set(key, { deviceWs, clientWs, startedAt: Date.now() });

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
        if (activeBridges.get(key)?.deviceWs === deviceWs) {
            activeBridges.delete(key);
            log(`KOPRU KAPANDI: ${deviceId}:${port} (${reason})`);
        }
        try { deviceWs.close(); } catch (_) {}
        try { clientWs.close(); } catch (_) {}
    };

    deviceWs.on('close', () => cleanup('cihaz baglantisi kapandi'));
    clientWs.on('close', () => cleanup('client baglantisi kapandi'));
    deviceWs.on('error', (err) => cleanup(`cihaz hatasi: ${err.message}`));
    clientWs.on('error', (err) => cleanup(`client hatasi: ${err.message}`));
}

setInterval(() => {
    const now = Date.now();
    for (const [deviceId, state] of devices.entries()) {
        for (const [port, info] of state.pendingByPort.entries()) {
            if (now - info.connectedAt > STALE_TIMEOUT_MS) {
                log(`ESKIMIS BEKLEME TEMIZLENDI: ${deviceId}:${port}`);
                try { info.ws.close(); } catch (_) {}
                state.pendingByPort.delete(port);
            }
        }
        if (!state.controlWs && state.pendingByPort.size === 0 && state.pendingConnectRequests.size === 0) {
            devices.delete(deviceId);
        }
    }
}, 60 * 1000);

server.listen(PORT, () => {
    log(`wboot-relay dinliyor: port ${PORT}`);
});
