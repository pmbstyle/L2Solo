require('../../Global');

const { parentPort, workerData } = require('worker_threads');
invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = workerData?.developerDiagnostics === true;
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
    const timed = request.townCorridor || workerData?.developerDiagnostics === true;
    const startedAt = timed ? performance.now() : null;
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
        parentPort.postMessage({ id, ok: true, path: result, workerMs: timed ? performance.now() - startedAt : null });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            code: error?.code,
            workerMs: timed ? performance.now() - startedAt : null,
            error: error?.message || String(error)
        });
    }
});
