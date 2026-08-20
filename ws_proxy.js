/**
 * ws_proxy.js
 *
 * ssh'in (ya da baska bir TCP istemcisinin) ProxyCommand'i olarak kullanilir.
 * stdin'den okudugunu WebSocket'e (relay'in "client" ucuna) yazar,
 * WebSocket'ten geleni stdout'a yazar. Boylece normal `ssh` komutu, relay
 * uzerinden gercek bir SSH oturumu acabilir.
 *
 * Cok-portlu protokol: /client/<device_id>/<port>
 *
 * Kullanim:
 *   node ws_proxy.js <device_id> [port]        # port varsayilani: 22
 *
 * Ornekler:
 *   ssh -o ProxyCommand="node ws_proxy.js test-device-abc123" srv@dummy
 *   node ws_proxy.js test-device-abc123 5900   # VNC icin
 *
 * Ortam degiskenleri:
 *   RELAY_URL           tam taban URL (yerel test: ws://localhost:3999)
 *   RELAY_HOST          yalnizca host (varsayilan: wboot-u646.onrender.com)
 *   RELAY_CLIENT_TOKEN  relay'in bekledigi client tokeni
 */

'use strict';

const WebSocket = require('ws');

const deviceId = process.argv[2];
const port = process.argv[3] || '22';

if (!deviceId) {
    process.stderr.write('Kullanim: node ws_proxy.js <device_id> [port]\n');
    process.exit(1);
}

const BASE = process.env.RELAY_URL || `wss://${process.env.RELAY_HOST || 'wboot-u646.onrender.com'}`;
const RELAY_URL = `${BASE}/client/${deviceId}/${port}`;
const CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN || '';
const WS_HIGH_WATER_MARK = 1024 * 1024;

const options = CLIENT_TOKEN ? { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } } : {};
const ws = new WebSocket(RELAY_URL, options);
ws.binaryType = 'nodebuffer';

/**
 * Relay, hata durumlarinda veri duzleminden JSON kontrol mesaji gonderir
 * (device_offline, connect_timeout, ...). Bunlar stdout'a yazilirsa SSH
 * akisini bozar - stderr'e ayriliyor. Kopru kurulup ilk gercek bayt
 * aktiginca ayristirma tamamen birakilir.
 */
let bridged = false;

function asControlMessage(data) {
    if (bridged || data.length === 0 || data[0] !== 0x7b /* '{' */) return null;
    try {
        const msg = JSON.parse(data.toString('utf8'));
        return msg && msg.type === 'error' ? msg : null;
    } catch (_) {
        return null;
    }
}

let exitCode = 0;

ws.on('open', () => {
    process.stderr.write(`[ws_proxy] relay'e baglandi (${deviceId}:${port})\n`);

    process.stdin.on('data', (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Relay'e yazma tamponu dolarsa stdin'i duraklat (scp/sftp icin onemli).
        if (ws.bufferedAmount > WS_HIGH_WATER_MARK) process.stdin.pause();
        ws.send(chunk, { binary: true }, () => {
            if (ws.bufferedAmount <= WS_HIGH_WATER_MARK / 4) process.stdin.resume();
        });
    });

    process.stdin.on('end', () => {
        try { ws.close(); } catch (_) {}
    });

    process.stdin.resume();
});

ws.on('message', (data) => {
    const control = asControlMessage(data);
    if (control) {
        process.stderr.write(`[ws_proxy] relay hatasi: ${control.code} - ${control.message}\n`);
        exitCode = 1;
        return;
    }
    bridged = true;
    // stdout dolarsa WS'i duraklat.
    if (process.stdout.write(data) === false) {
        ws.pause();
        process.stdout.once('drain', () => ws.resume());
    }
});

ws.on('close', (code, reason) => {
    const text = reason.toString();
    process.stderr.write(`[ws_proxy] baglanti kapandi: code=${code}${text ? ` reason=${text}` : ''}\n`);
    // Kopru hic kurulamadiysa ssh'a basarisizligi bildir.
    if (!bridged && code !== 1000 && code !== 1005) exitCode = 1;
    process.exit(exitCode);
});

ws.on('error', (err) => {
    process.stderr.write(`[ws_proxy] hata: ${err.message}\n`);
    process.exit(1);
});
