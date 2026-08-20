const WebSocket = require('ws');

const DEVICE_ID = 'test-device-abc123';
const BASE = 'ws://localhost:3999';

let deviceReceived = '';
let clientReceived = '';

const deviceWs = new WebSocket(`${BASE}/device/${DEVICE_ID}`);

deviceWs.on('open', () => {
    console.log('[device] bağlandı, client bekleniyor...');
});

deviceWs.on('message', (data) => {
    deviceReceived = data.toString();
    console.log('[device] mesaj aldı:', deviceReceived);
});

deviceWs.on('close', (code, reason) => {
    console.log('[device] bağlantı kapandı:', code, reason.toString());
});

// 500ms sonra client bağlansın (device'ın önce bağlanmış olması lazım)
setTimeout(() => {
    const clientWs = new WebSocket(`${BASE}/client/${DEVICE_ID}`);

    clientWs.on('open', () => {
        console.log('[client] bağlandı, köprü kurulmuş olmalı');
        clientWs.send('MERHABA_CIHAZ');
    });

    clientWs.on('message', (data) => {
        clientReceived = data.toString();
        console.log('[client] mesaj aldı:', clientReceived);
    });

    deviceWs.on('open', () => {}); // no-op, zaten açık

    // Device tarafından client'a mesaj gönder (bağlı olduğundan emin olmak için biraz bekle)
    setTimeout(() => {
        deviceWs.send('MERHABA_CLIENT');
    }, 300);

    setTimeout(() => {
        console.log('\n=== SONUÇ ===');
        console.log('device aldı:', deviceReceived === 'MERHABA_CIHAZ' ? 'DOĞRU ✓' : `YANLIŞ (${deviceReceived})`);
        console.log('client aldı:', clientReceived === 'MERHABA_CLIENT' ? 'DOĞRU ✓' : `YANLIŞ (${clientReceived})`);
        process.exit(0);
    }, 1000);
}, 500);
