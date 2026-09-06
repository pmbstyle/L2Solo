const assert = require('assert');
const { performance } = require('perf_hooks');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

(async () => {
    const enabled = Config.enabled;
    try {
        Config.enabled = true;
        Metrics.startEventLoopMonitor();
        await new Promise(resolve => setTimeout(resolve, 80));
        const until = performance.now() + 65;
        while (performance.now() < until) { /* Deliberate main-thread stall. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
        const first = Metrics.snapshot().eventLoop.delay;
        assert(first.samples > 0 && first.maxMs >= 60, 'sub-second stalls must appear in the histogram');
        assert(first.p99Ms >= first.p95Ms && first.maxMs >= first.p99Ms);
        const second = Metrics.snapshot().eventLoop.delay;
        assert.strictEqual(second.samples, 0, 'each summary must start a new measurement window');
        console.log('Event loop sub-second stall and window reset checks passed');
    } finally {
        Metrics.stopEventLoopMonitor();
        Config.enabled = enabled;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
