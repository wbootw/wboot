/**
 * device_bridge.js
 *
 * remote.c'nin gelecekte yapacagi isi Node ile taklit eder. Cihaz tarafinda
 * calisir, relay ile kontrol kanali + servis kanallari kurar.
 *
 * Davranis:
 *   - ALWAYS_ON portlar (22 SSH, 23 Telnet): baslangicta hemen ve surekli
 *     acik WS baglantisi kurulur (kapanirsa yeniden dener).
 *   - Kontrol kanali (/device/<id>/control): her zaman acik. Relay'den
 *     "connect-request" mesaji gelirse, o portu localhost'ta denemeye
 *     calisir (VNC/RDP gibi talep-aninda servisler icin).
 *   - Talep-aninda port acilirken localhost'a baglanamazsa (servis kapali),
 *     o WS baglantisini hic kurmadan birakir - relay zaten client'a
 *     zaman asimi hatasi dönecektir.
 *
 * Kullanim:
 *   node device_bridge.js <device_id>
 */

const WebSocket = require('ws');
const net = require('net');

const DEVICE_ID = process.argv[2] || 'test-device-abc123';
const RELAY_HOST = 'wboot-u646.onrender.com';
const LOCAL_HOST = '127.0.0.1';

const ALLOWED_PORTS = {
    22: 'SSH',
    23: 'Telnet',
    5900: 'VNC',
    3389: 'RDP',
};
const ALWAYS_ON_PORTS = [22, 23];

const RECONNECT_DELAY_MS = 5000;
const LOCAL_CONNECT_TIMEOUT_MS = 5000;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function relayUrl(pathSuffix) {
    return `wss://${RELAY_HOST}/device/${DEVICE_ID}/${pathSuffix}`;
}

// --- Servis kanali: relay'e bagli, gelen ilk veriyle localhost'a baglanir ---

function openServicePort(port, { onEstablished, onFail } = {}) {
    const serviceName = ALLOWED_PORTS[port] || `port-${port}`;
    const ws = new WebSocket(relayUrl(String(port)));
    let localSocket = null;
    let established = false;

    ws.on('open', () => {
        log(`[${serviceName}] relay'e baglandi, veri/client bekleniyor...`);
    });

    ws.on('message', (data) => {
        if (!localSocket) {
            localSocket = net.createConnection({ host: LOCAL_HOST, port }, () => {
                established = true;
                log(`[${serviceName}] yerel servise baglanildi (localhost:${port})`);
                localSocket.write(data);
                if (onEstablished) onEstablished();
            });

            localSocket.on('data', (chunk) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
            });

            localSocket.on('close', () => {
                log(`[${serviceName}] yerel baglanti kapandi`);
                try { ws.close(); } catch (_) {}
            });

            localSocket.on('error', (err) => {
                log(`[${serviceName}] yerel baglanti hatasi: ${err.message}`);
                try { ws.close(); } catch (_) {}
                if (!established && onFail) onFail(err);
            });
        } else {
            localSocket.write(data);
        }
    });

    ws.on('close', (code, reason) => {
        log(`[${serviceName}] relay baglantisi kapandi: code=${code} reason=${reason.toString()}`);
        if (localSocket) { try { localSocket.destroy(); } catch (_) {} }
        return { established };
    });

    ws.on('error', (err) => {
        log(`[${serviceName}] relay WS hatasi: ${err.message}`);
    });

    return ws;
}

// ALWAYS_ON portlar: kapanirsa surekli yeniden baglan.
function startAlwaysOnPort(port) {
    const serviceName = ALLOWED_PORTS[port];
    function connect() {
        const ws = openServicePort(port);
        ws.on('close', () => {
            log(`[${serviceName}] ${RECONNECT_DELAY_MS / 1000} saniye sonra yeniden baglanilacak...`);
            setTimeout(connect, RECONNECT_DELAY_MS);
        });
    }
    connect();
}

// --- Talep-aninda portlar: localhost'a once "yoklama" baglantisi dene,
//     basariliysa relay WS'ini ac. Basarisizsa relay'e hic baglanma. ---

function tryOpenOnDemandPort(port) {
    const serviceName = ALLOWED_PORTS[port] || `port-${port}`;
    const probe = net.createConnection({ host: LOCAL_HOST, port });
    let settled = false;

    const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`[${serviceName}] yoklama zaman asimi, servis kapali kabul edildi`);
        try { probe.destroy(); } catch (_) {}
    }, LOCAL_CONNECT_TIMEOUT_MS);

    probe.on('connect', () => {
        if (settled) { probe.destroy(); return; }
        settled = true;
        clearTimeout(timeoutHandle);
        log(`[${serviceName}] yoklama basarili, relay WS'i aciliyor...`);
        probe.destroy(); // yoklama soketini kapat, openServicePort kendi soketini acacak
        openServicePort(port);
    });

    probe.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        log(`[${serviceName}] yoklama basarisiz (${err.message}), servis kapali - relay'e baglanilmiyor`);
    });
}

// --- Kontrol kanali ---

function connectControlChannel() {
    const ws = new WebSocket(relayUrl('control'));

    ws.on('open', () => {
        log('Kontrol kanali baglandi, connect-request bekleniyor...');
    });

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (_) {
            log(`Kontrol kanalindan gecersiz JSON alindi: ${data}`);
            return;
        }

        if (msg.type === 'connect-request' && ALLOWED_PORTS[msg.port]) {
            log(`Connect-request alindi: port=${msg.port} (${ALLOWED_PORTS[msg.port]})`);
            tryOpenOnDemandPort(msg.port);
        }
    });

    ws.on('close', (code, reason) => {
        log(`Kontrol kanali kapandi: code=${code} reason=${reason.toString()} - ${RECONNECT_DELAY_MS / 1000}s sonra yeniden baglanilacak`);
        setTimeout(connectControlChannel, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
        log(`Kontrol kanali hatasi: ${err.message}`);
    });
}

// --- Baslat ---

log(`Cihaz baslatiliyor: ${DEVICE_ID}`);
ALWAYS_ON_PORTS.forEach(startAlwaysOnPort);
connectControlChannel();
