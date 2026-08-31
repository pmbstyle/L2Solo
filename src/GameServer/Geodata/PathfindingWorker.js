require('../../Global');

const { parentPort } = require('worker_threads');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

GeodataEngine.init();

parentPort.on('message', (message) => {
    if (!message || message.type !== 'path') return;
    const { id, request } = message;
    try {
        const path = GeodataEngine.findPath(
            request.startX,
            request.startY,
            request.startZ,
            request.endX,
            request.endY,
            request.endZ,
            request.maxNodes,
            {
                debug: false,
                goalRadius: request.goalRadius,
                goalZTolerance: request.goalZTolerance,
                heuristicWeight: request.heuristicWeight
            }
        );
        parentPort.postMessage({ id, ok: true, path });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: error?.message || String(error)
        });
    }
});
