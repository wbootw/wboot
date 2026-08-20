/**
 * server.js
 *
 * wboot-relay: WebSocket tabanli, NAT arkasindaki boot-recovery cihazlarina
 * disaridan cok-servisli erisim saglayan koprulayici sunucu.
 *
 * Mimarideki rolu: SADECE bir "kor boru". Icinden gecen trafigin icerigini
 * gormez, desifre etmez, saklamaz. Iki WebSocket baglantisini
 * (device <-> client) ham byte seviyesinde birbirine baglar.
 *
 * Endpoint'ler:
 *   wss://<host>/device/<device_id>/<port>     - cihazin belirli bir servis
 *                                                icin bagli oldugu taraf
 *   wss://<host>/device/<device_id>/control    - cihazin kontrol kanali
 *   wss://<host>/client/<device_id>/<port>     - teknik ekibin erisim tarafi
 *
 * DAIMA-ACIK portlar (ALWAYS_ON_PORTS): cihaz relay'e baglandigi an bu
 * portlar icin WS baglantisini hemen acar (SSH, Telnet). Bu portlara client
 * geldiginde bekleyen device soketi zaten hazirdir.
 *
 * TALEP-ANINDA portlar (VNC, RDP): cihaz onceden baglanmaz. Client bu
 * portlardan birine gelirse relay, cihazin control kanalina "connect-request"
 * yollar; cihaz o porta yeni bir WS acmayi dener.
 *
 * KONTROL DUZLEMI (control kanali uzerinden, JSON):
 *   relay -> cihaz  {"type":"connect-request","port":N}
 *   relay -> cihaz  {"type":"client-connected","port":N}
 *     Kopru kuruldugu an gonderilir. Sunucu-once konusan protokoller
 *     (Telnet IAC, VNC RFB) icin sarttir: cihaz yerel servise ancak bu
 *     sinyalle baglanir, ilk bayti beklemez.
 *
 * DB YOK, DISK YOK - her sey bellekte (Map).
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// --- Yapilandirma -----------------------------------------------------------

function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const PORT = envInt('PORT', 3000);

/** Paylasilan sirlar. Tanimli degilse o taraf icin dogrulama yapilmaz. */
const DEVICE_TOKEN = process.env.RELAY_DEVICE_TOKEN || '';
const CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN || '';

const ALLOWED_PORTS = {
    22: 'SSH',
    23: 'Telnet',
    5900: 'VNC',
    3389: 'RDP',
};

const ALWAYS_ON_PORTS = new Set([22, 23]);

/** Tek WS frame ust siniri. SSH paketi ~35 KB, TCP chunk'lari ~64 KB. */
const MAX_PAYLOAD_BYTES = envInt('RELAY_MAX_PAYLOAD', 1024 * 1024);

/** Cihazin connect-request'e cevap verme suresi. */
const CONNECT_REQUEST_TIMEOUT_MS = envInt('RELAY_CONNECT_TIMEOUT_MS', 15 * 1000);

/**
 * Talep-aninda portlarda, cevapsiz kalmis device soketlerinin temizlenme
 * suresi. ALWAYS_ON portlar bu temizlikten MUAFTIR - onlarin surekli acik
 * kalmasi tasarimin geregidir; olu soketleri ping/pong yakalar.
 */
const ON_DEMAND_STALE_MS = envInt('RELAY_ON_DEMAND_STALE_MS', 2 * 60 * 1000);

/** Ping araligi ve cevapsiz ping toleransi (olu baglanti tespiti). */
const HEARTBEAT_INTERVAL_MS = envInt('RELAY_HEARTBEAT_MS', 30 * 1000);
const HEARTBEAT_MAX_MISSED = envInt('RELAY_HEARTBEAT_MAX_MISSED', 2);

/** Kopru kurulmadan once tamponlanacak azami veri (protokol banner'lari). */
const PREBRIDGE_BUFFER_BYTES = envInt('RELAY_PREBRIDGE_BUFFER', 256 * 1024);

/** Backpressure esikleri: karsi taraf yavassa kaynak soket duraklatilir. */
const BACKPRESSURE_HIGH_BYTES = envInt('RELAY_BACKPRESSURE_HIGH', 1024 * 1024);
const BACKPRESSURE_LOW_BYTES = envInt('RELAY_BACKPRESSURE_LOW', 256 * 1024);

/** Kaynak tuketimi sinirlari. */
const MAX_DEVICES = envInt('RELAY_MAX_DEVICES', 1000);
const MAX_SOCKETS = envInt('RELAY_MAX_SOCKETS', 500);
const MAX_SOCKETS_PER_IP = envInt('RELAY_MAX_SOCKETS_PER_IP', 20);

/**
 * Tarayici kaynakli baglantilar (CSWSH). Mesru istemciler (ssh ProxyCommand,
 * cihaz kopru yazilimi) Origin gondermez; tarayici gonderir. Varsayilan
 * olarak Origin tasiyan upgrade'ler reddedilir.
 */
const ALLOW_BROWSER_ORIGINS = process.env.RELAY_ALLOW_BROWSER_ORIGINS === '1';

/** WS kapanis kodlari (uygulamaya ozel 4000-4999 araligi). */
const CLOSE_DEVICE_NOT_CONNECTED = 4404;
const CLOSE_PORT_BUSY = 4409;
const CLOSE_ERROR = 4503;
const CLOSE_SHUTDOWN = 1001;

// --- Durum ------------------------------------------------------------------

/** deviceId -> { controlWs, pendingByPort, pendingConnectRequests } */
const devices = new Map();
/** "deviceId:port" -> { deviceWs, clientWs, startedAt } */
const activeBridges = new Map();
/** Heartbeat ve kapanis icin tum canli soketler. */
const liveSockets = new Set();
/** ip -> acik soket sayisi */
const socketsByIp = new Map();

let shuttingDown = false;
const startedAt = Date.now();

// --- Yardimcilar ------------------------------------------------------------

function log(level, msg) {
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}
const info = (m) => log('info', m);
const warn = (m) => log('warn', m);

function safeDeviceId(id) {
    return /^[a-zA-Z0-9_-]{8,128}$/.test(id) ? id : null;
}

/**
 * Sabit zamanli token karsilastirmasi. Girdiler once hash'lenir; boylece
 * uzunluk farki da zamanlama yoluyla sizmaz.
 */
function tokenMatches(provided, expected) {
    if (!expected) return true; // dogrulama kapali
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function extractToken(req, url) {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const header = req.headers['x-relay-token'];
    if (typeof header === 'string' && header) return header;
    return url.searchParams.get('token') || '';
}

/**
 * Render gibi bir ters vekil arkasinda gercek istemci IP'si X-Forwarded-For'un
 * ilk degeridir. Dogrudan erisimde bu baslik sahte olabilir - yalnizca
 * kaynak sayaci icin kullaniliyor, yetkilendirmede kullanilmiyor.
 */
function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function bridgeKey(deviceId, port) {
    return `${deviceId}:${port}`;
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

function maybeDropDeviceState(deviceId, state) {
    if (!state.controlWs && state.pendingByPort.size === 0 && state.pendingConnectRequests.size === 0) {
        devices.delete(deviceId);
    }
}

/** Upgrade'i HTTP duzeyinde, sebep bildirerek reddet. */
function rejectUpgrade(socket, status, reason) {
    const body = `${status} ${reason}`;
    socket.write(
        `HTTP/1.1 ${status} ${reason}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
    socket.destroy();
}

function sendJsonError(ws, code, message) {
    try {
        ws.send(JSON.stringify({ type: 'error', code, message }));
    } catch (_) { /* soket zaten kapanmis olabilir */ }
    try { ws.close(CLOSE_ERROR, code); } catch (_) {}
}

function sendControl(state, payload) {
    const ws = state.controlWs;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch (_) {
        return false;
    }
}

// --- Soket kaydi, heartbeat, kaynak sayaci ---------------------------------

function registerSocket(ws, ip, label) {
    ws._relayLabel = label;
    ws._relayIp = ip;
    ws._missedPings = 0;
    liveSockets.add(ws);
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);

    ws.on('pong', () => { ws._missedPings = 0; });

    ws.on('close', () => {
        liveSockets.delete(ws);
        const n = (socketsByIp.get(ip) || 1) - 1;
        if (n <= 0) socketsByIp.delete(ip); else socketsByIp.set(ip, n);
    });

    // Kaydedilmemis 'error' olayi process'i dusurur; her soket icin garanti et.
    ws.on('error', (err) => {
        warn(`WS hatasi (${label}): ${err.message}`);
    });
}

const heartbeatTimer = setInterval(() => {
    for (const ws of liveSockets) {
        if (ws.readyState !== ws.OPEN) continue;
        if (ws._missedPings >= HEARTBEAT_MAX_MISSED) {
            warn(`Olu baglanti sonlandiriliyor (${ws._relayLabel}): ${ws._missedPings} cevapsiz ping`);
            ws.terminate();
            continue;
        }
        ws._missedPings += 1;
        try { ws.ping(); } catch (_) {}
    }
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

// --- Kopru oncesi tamponlama ------------------------------------------------

/**
 * Kopru kurulmadan once karsi taraftan veri gelirse kaybolmasin diye
 * tamponlar. Sunucu-once konusan protokollerde (Telnet, VNC) ve talep-aninda
 * portlarda client'in erken gonderdigi banner'da kritiktir.
 */
function attachPreBridgeBuffer(ws, label) {
    const buf = { chunks: [], bytes: 0, detached: false };

    const onMessage = (data, isBinary) => {
        const len = data.length !== undefined ? data.length : data.byteLength;
        if (buf.bytes + len > PREBRIDGE_BUFFER_BYTES) {
            warn(`Kopru oncesi tampon asildi (${label}), baglanti kapatiliyor`);
            try { ws.close(CLOSE_ERROR, 'prebridge_buffer_overflow'); } catch (_) {}
            return;
        }
        buf.chunks.push({ data, isBinary });
        buf.bytes += len;
    };

    ws.on('message', onMessage);
    buf.detach = () => {
        if (buf.detached) return;
        buf.detached = true;
        ws.removeListener('message', onMessage);
    };
    return buf;
}

function flushPreBridge(buf, dstWs) {
    if (!buf || buf.chunks.length === 0) return;
    for (const { data, isBinary } of buf.chunks) {
        if (dstWs.readyState !== dstWs.OPEN) break;
        try { dstWs.send(data, { binary: isBinary }); } catch (_) { break; }
    }
    buf.chunks.length = 0;
    buf.bytes = 0;
}

// --- HTTP -------------------------------------------------------------------

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
        let pendingCount = 0;
        for (const state of devices.values()) pendingCount += state.pendingByPort.size;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
            status: shuttingDown ? 'shutting_down' : 'ok',
            uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
            known_devices: devices.size,
            pending_device_sockets: pendingCount,
            active_bridges: activeBridges.size,
            live_sockets: liveSockets.size,
            auth: { device: Boolean(DEVICE_TOKEN), client: Boolean(CLIENT_TOKEN) },
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
});

const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false, // tasinan trafik zaten sifreli; sikistirma kazanc saglamaz
});

server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* upgrade tamamlanmadan kopan soketler */ });

    if (shuttingDown) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
    }

    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
    }

    if (!ALLOW_BROWSER_ORIGINS && req.headers.origin) {
        warn(`REDDEDILDI: tarayici kaynakli baglanti (origin=${req.headers.origin})`);
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
    }

    const ip = clientIp(req);
    if (liveSockets.size >= MAX_SOCKETS) {
        warn(`REDDEDILDI: sunucu soket siniri doldu (${MAX_SOCKETS})`);
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
    }
    if ((socketsByIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) {
        warn(`REDDEDILDI: IP basina soket siniri doldu (${ip})`);
        rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || !['device', 'client'].includes(parts[0])) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
    }

    const role = parts[0];
    const deviceId = safeDeviceId(parts[1]);
    const portToken = parts[2];

    if (!deviceId) {
        warn(`REDDEDILDI: gecersiz device_id formati (${parts[1]})`);
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
    }

    const expected = role === 'device' ? DEVICE_TOKEN : CLIENT_TOKEN;
    if (!tokenMatches(extractToken(req, url), expected)) {
        warn(`REDDEDILDI: gecersiz token (${role} ${deviceId})`);
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
    }

    if (role === 'device' && portToken === 'control') {
        if (!devices.has(deviceId) && devices.size >= MAX_DEVICES) {
            warn(`REDDEDILDI: cihaz siniri doldu (${MAX_DEVICES})`);
            rejectUpgrade(socket, 503, 'Service Unavailable');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            registerSocket(ws, ip, `device-control ${deviceId}`);
            handleDeviceControlConnection(ws, deviceId);
        });
        return;
    }

    const port = Number(portToken);
    if (!Number.isInteger(port) || !ALLOWED_PORTS[port]) {
        warn(`REDDEDILDI: desteklenmeyen port (${portToken}) - ${deviceId}`);
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
    }

    if (!devices.has(deviceId) && devices.size >= MAX_DEVICES) {
        warn(`REDDEDILDI: cihaz siniri doldu (${MAX_DEVICES})`);
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        registerSocket(ws, ip, `${role} ${deviceId}:${port}`);
        if (role === 'device') {
            handleDevicePortConnection(ws, deviceId, port);
        } else {
            handleClientConnection(ws, deviceId, port);
        }
    });
});

// --- Cihaz: kontrol kanali --------------------------------------------------

function handleDeviceControlConnection(ws, deviceId) {
    const state = getOrCreateDeviceState(deviceId);

    if (state.controlWs && state.controlWs !== ws) {
        info(`Cihaz ${deviceId} icin eski kontrol kanali kapatiliyor (yeniden baglanma)`);
        const old = state.controlWs;
        state.controlWs = null;
        try { old.close(CLOSE_PORT_BUSY, 'superseded'); } catch (_) {}
    }
    state.controlWs = ws;
    info(`Cihaz kontrol kanali baglandi: ${deviceId}`);

    ws.on('close', () => {
        if (state.controlWs === ws) {
            state.controlWs = null;
            info(`Cihaz kontrol kanali kapandi: ${deviceId}`);
        }
        maybeDropDeviceState(deviceId, state);
    });
}

// --- Cihaz: servis portu ----------------------------------------------------

function handleDevicePortConnection(ws, deviceId, port) {
    const state = getOrCreateDeviceState(deviceId);

    const existingPending = state.pendingByPort.get(port);
    if (existingPending) {
        info(`Cihaz ${deviceId}:${port} yeniden baglandi, eski bekleyen baglanti kapatiliyor`);
        state.pendingByPort.delete(port);
        existingPending.buffer.detach();
        try { existingPending.ws.close(CLOSE_PORT_BUSY, 'superseded'); } catch (_) {}
    }

    const key = bridgeKey(deviceId, port);
    const existingBridge = activeBridges.get(key);
    if (existingBridge) {
        info(`Cihaz ${deviceId}:${port} aktif kopru varken tekrar baglandi, eski kopru kapatiliyor`);
        activeBridges.delete(key);
        try { existingBridge.deviceWs.close(CLOSE_PORT_BUSY, 'superseded'); } catch (_) {}
        try { existingBridge.clientWs.close(CLOSE_PORT_BUSY, 'superseded'); } catch (_) {}
    }

    // Cihaz, client'i beklerken banner gonderebilir (Telnet/VNC). Tamponla.
    const buffer = attachPreBridgeBuffer(ws, `device ${deviceId}:${port}`);

    // Bu port icin bekleyen bir client varsa dogrudan kopruye gec.
    const waitingRequest = state.pendingConnectRequests.get(port);
    if (waitingRequest) {
        clearTimeout(waitingRequest.timeoutHandle);
        state.pendingConnectRequests.delete(port);
        bridgeConnections(deviceId, port, ws, buffer, waitingRequest.clientWs, waitingRequest.buffer);
        return;
    }

    state.pendingByPort.set(port, { ws, buffer, connectedAt: Date.now() });
    info(`Cihaz bekliyor: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);

    ws.on('close', () => {
        const entry = state.pendingByPort.get(port);
        if (entry && entry.ws === ws) {
            state.pendingByPort.delete(port);
            buffer.detach();
            info(`Cihaz baglantisi kapandi (bekleme listesinden cikti): ${deviceId}:${port}`);
        }
        maybeDropDeviceState(deviceId, state);
    });
}

// --- Client -----------------------------------------------------------------

function handleClientConnection(ws, deviceId, port) {
    const state = getOrCreateDeviceState(deviceId);

    if (activeBridges.has(bridgeKey(deviceId, port))) {
        info(`REDDEDILDI: ${deviceId}:${port} icin zaten aktif bir oturum var`);
        try { ws.close(CLOSE_PORT_BUSY, 'session in use'); } catch (_) {}
        maybeDropDeviceState(deviceId, state);
        return;
    }

    const pending = state.pendingByPort.get(port);
    if (pending) {
        state.pendingByPort.delete(port);
        const clientBuffer = attachPreBridgeBuffer(ws, `client ${deviceId}:${port}`);
        bridgeConnections(deviceId, port, pending.ws, pending.buffer, ws, clientBuffer);
        return;
    }

    if (ALWAYS_ON_PORTS.has(port)) {
        info(`REDDEDILDI: client, bekleyen cihaz olmadan baglanmaya calisti (${deviceId}:${port})`);
        try { ws.close(CLOSE_DEVICE_NOT_CONNECTED, 'device not connected'); } catch (_) {}
        maybeDropDeviceState(deviceId, state);
        return;
    }

    // --- Talep-aninda port ---
    if (state.pendingConnectRequests.has(port)) {
        info(`REDDEDILDI: ${deviceId}:${port} icin zaten bekleyen bir talep var`);
        try { ws.close(CLOSE_PORT_BUSY, 'connect request in progress'); } catch (_) {}
        return;
    }

    if (!state.controlWs || state.controlWs.readyState !== state.controlWs.OPEN) {
        info(`REDDEDILDI: cihaz kontrol kanali yok (${deviceId}:${port})`);
        sendJsonError(ws, 'device_offline', `${deviceId} icin cihaz baglantisi (control channel) yok`);
        maybeDropDeviceState(deviceId, state);
        return;
    }

    info(`TALEP-ANINDA baglanti istendi: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);

    // Client, cihaz baglanmadan once banner gonderebilir (SSH/RDP). Tamponla.
    const buffer = attachPreBridgeBuffer(ws, `client ${deviceId}:${port}`);

    const entry = { clientWs: ws, buffer, timeoutHandle: null };
    entry.timeoutHandle = setTimeout(() => {
        // Yalnizca KENDI kaydini sil - araya giren baska bir talebi degil.
        if (state.pendingConnectRequests.get(port) === entry) {
            state.pendingConnectRequests.delete(port);
        }
        buffer.detach();
        warn(`ZAMAN ASIMI: cihaz ${deviceId}:${port} portuna zamaninda baglanmadi`);
        sendJsonError(ws, 'connect_timeout', `Cihaz ${ALLOWED_PORTS[port]} (port ${port}) servisine baglanamadi (zaman asimi)`);
        maybeDropDeviceState(deviceId, state);
    }, CONNECT_REQUEST_TIMEOUT_MS);

    state.pendingConnectRequests.set(port, entry);

    if (!sendControl(state, { type: 'connect-request', port })) {
        clearTimeout(entry.timeoutHandle);
        if (state.pendingConnectRequests.get(port) === entry) {
            state.pendingConnectRequests.delete(port);
        }
        buffer.detach();
        sendJsonError(ws, 'control_channel_error', 'Cihaza istek iletilemedi');
        maybeDropDeviceState(deviceId, state);
        return;
    }

    ws.on('close', () => {
        if (state.pendingConnectRequests.get(port) === entry) {
            clearTimeout(entry.timeoutHandle);
            state.pendingConnectRequests.delete(port);
            buffer.detach();
        }
        maybeDropDeviceState(deviceId, state);
    });
}

// --- Kopru ------------------------------------------------------------------

/**
 * Iki soketi ham byte seviyesinde baglar. Karsi tarafin yazma tamponu
 * BACKPRESSURE_HIGH_BYTES'i asarsa kaynak soket duraklatilir, tampon
 * BACKPRESSURE_LOW_BYTES'in altina dusunce devam ettirilir.
 */
function pipeSocket(src, dst, label) {
    let paused = false;

    src.on('message', (data, isBinary) => {
        if (dst.readyState !== dst.OPEN) return;

        if (!paused && dst.bufferedAmount > BACKPRESSURE_HIGH_BYTES) {
            paused = true;
            src.pause();
        }

        dst.send(data, { binary: isBinary }, () => {
            if (paused && dst.bufferedAmount <= BACKPRESSURE_LOW_BYTES) {
                paused = false;
                src.resume();
            }
        });
    });
}

function bridgeConnections(deviceId, port, deviceWs, deviceBuffer, clientWs, clientBuffer) {
    const key = bridgeKey(deviceId, port);
    const state = devices.get(deviceId);

    if (deviceWs.readyState !== deviceWs.OPEN || clientWs.readyState !== clientWs.OPEN) {
        // Taraflardan biri kopru kurulmadan kapandi.
        if (deviceBuffer) deviceBuffer.detach();
        if (clientBuffer) clientBuffer.detach();
        try { deviceWs.close(); } catch (_) {}
        try { clientWs.close(); } catch (_) {}
        return;
    }

    info(`KOPRU KURULDU: ${deviceId}:${port} (${ALLOWED_PORTS[port]})`);
    activeBridges.set(key, { deviceWs, clientWs, startedAt: Date.now() });

    // Tampon listener'larini kaldirip yerine kopru listener'larini kur.
    // Sirasi onemli: once detach, sonra pipe, sonra flush - boylece
    // tamponlanan veri yeni gelenlerin onunde kalir.
    if (deviceBuffer) deviceBuffer.detach();
    if (clientBuffer) clientBuffer.detach();

    pipeSocket(deviceWs, clientWs, `${deviceId}:${port} device->client`);
    pipeSocket(clientWs, deviceWs, `${deviceId}:${port} client->device`);

    flushPreBridge(deviceBuffer, clientWs);
    flushPreBridge(clientBuffer, deviceWs);

    // Sunucu-once konusan protokoller icin cihaza "client geldi" sinyali.
    if (state) sendControl(state, { type: 'client-connected', port });

    let closed = false;
    const cleanup = (reason) => {
        if (closed) return;
        closed = true;
        if (activeBridges.get(key)?.deviceWs === deviceWs) {
            activeBridges.delete(key);
        }
        info(`KOPRU KAPANDI: ${deviceId}:${port} (${reason})`);
        try { deviceWs.close(); } catch (_) {}
        try { clientWs.close(); } catch (_) {}
        if (state) maybeDropDeviceState(deviceId, state);
    };

    deviceWs.on('close', () => cleanup('cihaz baglantisi kapandi'));
    clientWs.on('close', () => cleanup('client baglantisi kapandi'));
    deviceWs.on('error', (err) => cleanup(`cihaz hatasi: ${err.message}`));
    clientWs.on('error', (err) => cleanup(`client hatasi: ${err.message}`));
}

// --- Periyodik temizlik -----------------------------------------------------

const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, state] of devices.entries()) {
        for (const [port, entry] of state.pendingByPort.entries()) {
            // ALWAYS_ON portlar muaf: surekli acik kalmalari tasarimin geregi.
            // Olu soketleri heartbeat yakalar.
            if (ALWAYS_ON_PORTS.has(port)) continue;
            if (now - entry.connectedAt > ON_DEMAND_STALE_MS) {
                info(`ESKIMIS BEKLEME TEMIZLENDI: ${deviceId}:${port}`);
                state.pendingByPort.delete(port);
                entry.buffer.detach();
                try { entry.ws.close(CLOSE_ERROR, 'stale'); } catch (_) {}
            }
        }
        maybeDropDeviceState(deviceId, state);
    }
}, 60 * 1000);
sweepTimer.unref();

// --- Baslatma ve duzgun kapanma --------------------------------------------

/**
 * Sessiz olumu onler. Yakalanmamis bir istisna ya da reddedilen promise,
 * hicbir iz birakmadan sureci dusurur - platform loglarinda yalnizca yeniden
 * baslatma gorunur. Once sebebi yaziyor, sonra cikiyoruz.
 */
process.on('uncaughtException', (err) => {
    log('fatal', `YAKALANMAMIS ISTISNA: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log('fatal', `ISLENMEMIS PROMISE REDDI: ${reason && reason.stack ? reason.stack : reason}`);
    process.exit(1);
});

server.on('error', (err) => {
    log('fatal', `HTTP SUNUCU HATASI: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
    info(`wboot-relay dinliyor: 0.0.0.0:${PORT}`);
    info(`Node ${process.version}, pid ${process.pid}`);
    info(`Sinirlar: maxPayload=${MAX_PAYLOAD_BYTES}B soket=${MAX_SOCKETS} cihaz=${MAX_DEVICES} ip=${MAX_SOCKETS_PER_IP}`);
    info(`Heartbeat: ${HEARTBEAT_INTERVAL_MS / 1000}s araliginda, ${HEARTBEAT_MAX_MISSED} cevapsiz ping sonrasi kopar`);
    if (!DEVICE_TOKEN) warn('RELAY_DEVICE_TOKEN tanimli DEGIL - cihaz tarafi kimlik dogrulamasi KAPALI');
    if (!CLIENT_TOKEN) warn('RELAY_CLIENT_TOKEN tanimli DEGIL - client tarafi kimlik dogrulamasi KAPALI');
});

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`${signal} alindi, duzgun kapatiliyor...`);

    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);

    for (const ws of liveSockets) {
        try { ws.close(CLOSE_SHUTDOWN, 'relay restarting'); } catch (_) {}
    }

    server.close(() => {
        info('Kapandi.');
        process.exit(0);
    });

    setTimeout(() => {
        warn('Duzgun kapanma zaman asimi, zorla cikiliyor.');
        for (const ws of liveSockets) {
            try { ws.terminate(); } catch (_) {}
        }
        process.exit(0);
    }, 10 * 1000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
