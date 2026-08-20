const WebSocket = require('ws');
const BASE = 'ws://localhost:3999';

// Test: hiç bağlı cihaz olmayan bir ID'ye client bağlanmaya çalışırsa
const clientWs = new WebSocket(`${BASE}/client/hic-boyle-bir-cihaz-yok-999`);

clientWs.on('open', () => {
    console.log('BEKLENMEDİK: client bağlandı ama cihaz yoktu!');
});

clientWs.on('close', (code, reason) => {
    console.log(`Sonuç: bağlantı reddedildi/kapandı - code=${code} reason="${reason.toString()}"`);
    console.log(code === 4404 ? 'DOĞRU ✓ (beklenen 4404 device-not-connected)' : 'BEKLENMEYEN KOD');
    process.exit(0);
});

clientWs.on('error', (err) => {
    console.log('WS error:', err.message);
});

setTimeout(() => {
    console.log('TIMEOUT - hiçbir cevap gelmedi');
    process.exit(1);
}, 3000);
