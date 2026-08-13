const { parentPort } = require('worker_threads');

parentPort.on('message', (message) => {
    if (!message || message.type !== 'path') return;
    const { id, request } = message;
    const delayMs = Math.abs(Number(request.endX)) === 1000 ? 120 : 10;
    setTimeout(() => {
        parentPort.postMessage({
            id,
            ok: true,
            path: [
                { locX: request.startX + 2, locY: request.startY, locZ: request.startZ },
                { locX: request.endX, locY: request.endY, locZ: request.endZ }
            ]
        });
    }, delayMs);
});
