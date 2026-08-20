/**
 * device_bridge.js
 *
 * remote.c'nin gelecekte yapacagi isi Node ile taklit eder. Cihaz tarafinda
 * calisir, relay ile kontrol kanali + servis kanallari kurar.
 *
 * Davranis:
 *   - ALWAYS_ON portlar (22 SSH, 23 Telnet): baslangicta hemen ve surekli
 *     acik WS baglantisi kurulur; kopmada ustel geri cekilmeyle yeniden dener.
 *   - Kontrol kanali (/device/<id>/control): her zaman acik.
 *       * "connect-request": talep-aninda bir portu (VNC/RDP) acmayi dener.
 *       * "client-connected": o port icin kopru kuruldu. Yerel servise HEMEN
 *         baglanilir - ilk bayt beklenmez. Sunucu-once konusan protokoller
 *         (Telnet IAC, VNC RFB) yalnizca bu sinyal sayesinde calisir.
 *   - Talep-aninda port acilirken localhost'a baglanamazsa (servis kapali),
 *     relay WS'i hic acilmaz; relay client'a zaman asimi hatasi doner.
 *
 * Kullanim:
 *   node device_bridge.js <device_id>
 *
 * Ortam degiskenleri:
 *   RELAY_URL           tam taban URL (yerel test: ws://localhost:3999)
 *   RELAY_HOST          yalnizca host (varsayilan: wboot-u646.onrender.com)
 *   RELAY_DEVICE_TOKEN  relay'in bekledigi cihaz tokeni
 *   LOCAL_HOST          yerel servislerin adresi (varsayilan 127.0.0.1)
 */

'use strict';

const WebSocket = require('ws');
const net = require('net');

const DEVICE_ID = process.argv[2] || 'test-device-abc123';
const RELAY_BASE = process.env.RELAY_URL || `wss://${process.env.RELAY_HOST || 'wboot-u646.onrender.com'}`;
const DEVICE_TOKEN = process.env.RELAY_DEVICE_TOKEN || '';
const LOCAL_HOST = process.env.LOCAL_HOST || '127.0.0.1';

const ALLOWED_PORTS = {
    22: 'SSH',
    23: 'Telnet',
    5900: 'VNC',
    3389: 'RDP',
};
const ALWAYS_ON_PORTS = [22, 23];

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const LOCAL_CONNECT_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_MAX_MISSED = 2;
const WS_HIGH_WATER_MARK = 1024 * 1024;

/** port -> aktif servis kanali (kontrol kanalinin ulasabilmesi icin) */
const services = new Map();

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function relayUrl(pathSuffix) {
    return `${RELAY_BASE}/device/${DEVICE_ID}/${pathSuffix}`;
}

function connectRelay(pathSuffix) {
    const options = DEVICE_TOKEN ? { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } } : {};
    return new WebSocket(relayUrl(pathSuffix), options);
}

/** Ustel geri cekilme: 1s, 2s, 4s ... 30s tavanina kadar. */
function nextBackoff(current) {
    return Math.min(current > 0 ? current * 2 : RECONNECT_MIN_MS, RECONNECT_MAX_MS);
}

/**
 * Olu baglanti tespiti. Relay de ping gonderiyor; bu, ters yonde (relay ya da
 * aradaki NAT/proxy sessizce dustuyse) cihazin bunu fark etmesini saglar.
 */
function startHeartbeat(ws, label) {
    let missed = 0;
    const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (missed >= HEARTBEAT_MAX_MISSED) {
            log(`[${label}] relay cevap vermiyor (${missed} cevapsiz ping), baglanti kesiliyor`);
            try { ws.terminate(); } catch (_) {}
            return;
        }
        missed += 1;
        try { ws.ping(); } catch (_) {}
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref();

    ws.on('pong', () => { missed = 0; });
    ws.on('close', () => clearInterval(timer));
}

// --- Servis kanali ----------------------------------------------------------

/**
 * Bir servis portu icin relay baglantisi acar. Yerel sokete baglanma
 * ensureLocal() ile tetiklenir: ya relay'den ilk veri geldiginde
 * (client-once protokoller), ya da "client-connected" sinyalinde
 * (sunucu-once protokoller).
 */
function openServicePort(port) {
    const serviceName = ALLOWED_PORTS[port] || `port-${port}`;
    const ws = connectRelay(String(port));
    let localSocket = null;
    let localReady = false;
    const pendingToLocal = [];

    function flushToLocal() {
        while (pendingToLocal.length > 0) {
            const chunk = pendingToLocal.shift();
            writeToLocal(chunk);
        }
    }

    function writeToLocal(chunk) {
        if (!localSocket || localSocket.destroyed) return;
        // TCP tarafi doldugunda WS'i duraklat (backpressure).
        if (localSocket.write(chunk) === false) {
            ws.pause();
            localSocket.once('drain', () => ws.resume());
        }
    }

    function ensureLocal() {
        if (localSocket) return;
        log(`[${serviceName}] yerel servise baglaniliyor (${LOCAL_HOST}:${port})...`);

        localSocket = net.createConnection({ host: LOCAL_HOST, port }, () => {
            localReady = true;
            log(`[${serviceName}] yerel servise baglanildi`);
            flushToLocal();
        });

        localSocket.setNoDelay(true);

        localSocket.on('data', (chunk) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // WS tarafi doldugunda TCP'yi duraklat (ters yon backpressure).
            if (ws.bufferedAmount > WS_HIGH_WATER_MARK) localSocket.pause();
            ws.send(chunk, { binary: true }, () => {
                if (ws.bufferedAmount <= WS_HIGH_WATER_MARK / 4 && !localSocket.destroyed) {
                    localSocket.resume();
                }
            });
        });

        localSocket.on('close', () => {
            log(`[${serviceName}] yerel baglanti kapandi`);
            try { ws.close(); } catch (_) {}
        });

        localSocket.on('error', (err) => {
            log(`[${serviceName}] yerel baglanti hatasi: ${err.message}`);
            try { ws.close(); } catch (_) {}
        });
    }

    ws.on('open', () => {
        log(`[${serviceName}] relay'e baglandi, client bekleniyor...`);
        services.set(port, { ws, ensureLocal });
    });

    ws.on('message', (data) => {
        // Ilk veri geldiyse kopru kurulmus demektir; yerel baglanti yoksa ac.
        ensureLocal();
        if (localReady) writeToLocal(data);
        else pendingToLocal.push(data);
    });

    ws.on('close', (code, reason) => {
        log(`[${serviceName}] relay baglantisi kapandi: code=${code} reason=${reason.toString()}`);
        if (services.get(port)?.ws === ws) services.delete(port);
        if (localSocket) { try { localSocket.destroy(); } catch (_) {} }
    });

    ws.on('error', (err) => {
        log(`[${serviceName}] relay WS hatasi: ${err.message}`);
    });

    startHeartbeat(ws, serviceName);
    return { ws, ensureLocal };
}

/** ALWAYS_ON portlar: kopmada ustel geri cekilmeyle surekli yeniden baglan. */
function startAlwaysOnPort(port) {
    const serviceName = ALLOWED_PORTS[port];
    let backoff = 0;

    function connect() {
        const { ws } = openServicePort(port);

        ws.on('open', () => { backoff = 0; });

        ws.on('close', () => {
            backoff = nextBackoff(backoff);
            log(`[${serviceName}] ${backoff / 1000} saniye sonra yeniden baglanilacak...`);
            setTimeout(connect, backoff).unref();
        });
    }
    connect();
}

// --- Talep-aninda portlar ---------------------------------------------------

/**
 * Once localhost'a kisa bir "yoklama" baglantisi dener. Servis kapaliysa
 * relay'e hic baglanilmaz - relay client'a zaman asimi hatasi doner.
 */
function tryOpenOnDemandPort(port) {
    const serviceName = ALLOWED_PORTS[port] || `port-${port}`;

    if (services.has(port)) {
        log(`[${serviceName}] zaten acik bir kanal var, yeni istek yok sayildi`);
        return;
    }

    const probe = net.createConnection({ host: LOCAL_HOST, port });
    let settled = false;

    const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`[${serviceName}] yoklama zaman asimi, servis kapali kabul edildi`);
        try { probe.destroy(); } catch (_) {}
    }, LOCAL_CONNECT_TIMEOUT_MS);
    timeoutHandle.unref();

    probe.on('connect', () => {
        if (settled) { probe.destroy(); return; }
        settled = true;
        clearTimeout(timeoutHandle);
        log(`[${serviceName}] yoklama basarili, relay WS'i aciliyor...`);
        probe.destroy(); // openServicePort kendi soketini acacak
        openServicePort(port);
    });

    probe.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        log(`[${serviceName}] yoklama basarisiz (${err.message}), servis kapali - relay'e baglanilmiyor`);
    });
}

// --- Kontrol kanali ---------------------------------------------------------

function connectControlChannel(backoff = 0) {
    const ws = connectRelay('control');

    ws.on('open', () => {
        backoff = 0;
        log('Kontrol kanali baglandi, komut bekleniyor...');
    });

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (_) {
            log(`Kontrol kanalindan gecersiz JSON alindi: ${data}`);
            return;
        }

        if (!msg || !ALLOWED_PORTS[msg.port]) return;
        const serviceName = ALLOWED_PORTS[msg.port];

        if (msg.type === 'connect-request') {
            log(`Connect-request alindi: port=${msg.port} (${serviceName})`);
            tryOpenOnDemandPort(msg.port);
            return;
        }

        if (msg.type === 'client-connected') {
            // Kopru kuruldu. Sunucu-once protokollerde ilk bayti YEREL servis
            // gonderecegi icin yerel baglantiyi simdi acmak zorundayiz.
            log(`Client baglandi: port=${msg.port} (${serviceName}) - yerel servis aciliyor`);
            const service = services.get(msg.port);
            if (service) service.ensureLocal();
            else log(`UYARI: port=${msg.port} icin acik servis kanali yok`);
        }
    });

    ws.on('close', (code, reason) => {
        const delay = nextBackoff(backoff);
        log(`Kontrol kanali kapandi: code=${code} reason=${reason.toString()} - ${delay / 1000}s sonra yeniden baglanilacak`);
        setTimeout(() => connectControlChannel(delay), delay).unref();
    });

    ws.on('error', (err) => {
        log(`Kontrol kanali hatasi: ${err.message}`);
    });

    startHeartbeat(ws, 'control');
}

// --- Baslat -----------------------------------------------------------------

log(`Cihaz baslatiliyor: ${DEVICE_ID} -> ${RELAY_BASE}`);
if (!DEVICE_TOKEN) log('UYARI: RELAY_DEVICE_TOKEN tanimli degil - token gonderilmeyecek');
ALWAYS_ON_PORTS.forEach(startAlwaysOnPort);
connectControlChannel();
