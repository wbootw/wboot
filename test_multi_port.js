/**
 * test_multi_port.js
 *
 * Yerel relay (localhost:3999) + device_bridge.js calisiyorken:
 *   1) SSH (22, always-on) portuna client baglanip veri kopruleniyor mu?
 *   2) VNC (5900, talep-aninda) portuna baglaninca ne oluyor?
 *      - Eger localhost:5900'de bir sey calismiyorsa timeout/hata beklenir.
 *
 * Kullanim:
 *   Terminal 1: PORT=3999 node server.js
 *   Terminal 2: node device_bridge.js test-device-abc123
 *   Terminal 3: RELAY=ws://localhost:3999 node test_multi_port.js
 */

const WebSocket = require('ws');
const BASE = process.env.RELAY || 'ws://localhost:3999';
const DEVICE_ID = 'test-device-abc123';

function testAlwaysOnPort() {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${BASE}/client/${DEVICE_ID}/22`);
        let gotData = false;

        ws.on('open', () => {
            console.log('[SSH-22] client bagli, veri bekleniyor...');
            ws.send('TEST');
        });
        ws.on('message', (data) => {
            gotData = true;
            console.log('[SSH-22] veri geldi (ilk birkac byte):', data.toString().slice(0, 40));
        });
        ws.on('close', (code) => {
            console.log(`[SSH-22] kapandi code=${code} veri-alindi=${gotData}`);
            resolve();
        });
        ws.on('error', (err) => console.log('[SSH-22] HATA:', err.message));

        setTimeout(() => { try { ws.close(); } catch (_) {} }, 3000);
    });
}

function testOnDemandPort(port, label) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`${BASE}/client/${DEVICE_ID}/${port}`);

        ws.on('open', () => console.log(`[${label}] client bagli, cihazin baglanmasi bekleniyor...`));
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                console.log(`[${label}] JSON mesaj:`, msg);
            } catch (_) {
                console.log(`[${label}] binary veri geldi (${data.length} byte) - servis calisiyor demek`);
            }
        });
        ws.on('close', (code, reason) => {
            console.log(`[${label}] kapandi code=${code} reason=${reason.toString()}`);
            resolve();
        });
        ws.on('error', (err) => console.log(`[${label}] HATA:`, err.message));
    });
}

(async () => {
    await testAlwaysOnPort();
    console.log('---');
    await testOnDemandPort(5900, 'VNC-5900');
    console.log('---');
    await testOnDemandPort(3389, 'RDP-3389');
    process.exit(0);
})();
