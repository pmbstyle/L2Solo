require('../../Global');

const { parentPort } = require('worker_threads');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const TownPathCorridor = invoke('GameServer/Geodata/TownPathCorridor');

GeodataEngine.init();
let navigationRevision = null;

parentPort.on('message', (message) => {
    if (!message || message.type !== 'path') return;
    const { id, request } = message;
    if (request.townCorridor) {
        if (navigationRevision !== null && navigationRevision !== request.navigationRevision) GeodataEngine.init();
        navigationRevision = request.navigationRevision;
    }
    const startedAt = performance.now();
    const cancelFlag = message.cancelBuffer ? new Int32Array(message.cancelBuffer) : null;
    const checkBudget = () => {
        const cancelled = cancelFlag && Atomics.load(cancelFlag, 0) !== 0;
        if (cancelled || (request.townCorridor && performance.now() - startedAt > 150)) {
            throw Object.assign(new Error(cancelled ? 'path cancelled' : 'path work budget exceeded'), {
                code: cancelled ? 'STALE_PATH' : 'PATH_BUDGET'
            });
        }
    };
    try {
        checkBudget();
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
                heuristicWeight: request.heuristicWeight,
                checkBudget
            }
        );
        const result = request.townCorridor ? TownPathCorridor.build(path, checkBudget) : path;
        parentPort.postMessage({ id, ok: true, path: result, workerMs: performance.now() - startedAt });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            code: error?.code,
            workerMs: performance.now() - startedAt,
            error: error?.message || String(error)
        });
    }
});
