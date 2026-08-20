const WebSocket = require('ws');
const BASE = 'ws://localhost:3999';

const tests = [
    { id: 'ab', desc: 'çok kısa (8 karakterden az)' },
    { id: '../../etc/passwd', desc: 'path traversal denemesi (encode edilmemiş)' },
    { id: 'valid-id-12345678', desc: 'geçerli format (kontrol amaçlı, kabul edilmeli)' },
];

let completed = 0;

tests.forEach((t) => {
    const ws = new WebSocket(`${BASE}/device/${encodeURIComponent(t.id)}`);
    let resolved = false;

    ws.on('open', () => {
        if (!resolved) {
            resolved = true;
            console.log(`[${t.desc}] KABUL EDİLDİ (bağlantı açıldı)`);
            completed++;
            if (completed === tests.length) process.exit(0);
        }
    });

    ws.on('close', (code) => {
        if (!resolved) {
            resolved = true;
            console.log(`[${t.desc}] REDDEDİLDİ (code=${code})`);
            completed++;
            if (completed === tests.length) process.exit(0);
        }
    });

    ws.on('error', () => {}); // beklenen, sessizce geç
});

setTimeout(() => {
    console.log('Bazı testler tamamlanamadı (timeout)');
    process.exit(1);
}, 3000);
