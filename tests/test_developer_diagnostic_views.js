const assert = require('assert');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Session = invoke('GameServer/Session');
const MoveTo = invoke('GameServer/Actor/Generics/MoveTo');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const Tracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const Workflow = invoke('GameServer/Bot/AI/BotWorkflowTelemetry');
const cancelSkill = invoke('GameServer/Network/Response/MagicSkillCanceld');

async function run() {
    Config.developerDiagnostics = false;
    process.env.L2NODE_PACKET_TRACE = '1';
    const session = new Session({ write() {} });
    assert.strictEqual(session.packetTrace, undefined);
    assert.strictEqual(session.movementPacketTrace, undefined);
    const packet = Buffer.from([1]);
    Object.defineProperty(packet, '__packetTrace', { get() { throw new Error('diagnostic payload read off'); } });
    session.recordOutboundPacket(packet);
    session.tracePacket('in', packet, 'Move');
    session.dumpPacketTrace();
    const movement = {};
    MoveTo.recordMovementTrace(movement, { event: 'move' });
    assert.strictEqual(movement.movementTrace, undefined);
    assert.strictEqual(cancelSkill(42).__packetTrace, undefined);
    const target = { locX: 83396, locY: 147904, locZ: -3404 };
    const origin = { locX: 76000, locY: 144000, locZ: -3600 };
    const offRoute = TownPathfinder.routeWithSession({}, null, origin, target);
    assert.deepStrictEqual(Object.keys(offRoute.diagnostics), ['changedTarget']);
    assert.strictEqual(TownPathfinder.describeDiagnostics({}), null);
    assert.deepStrictEqual(Tracing.init({ enabled: true }), { enabled: false, initialized: false });
    let payloadReads = 0;
    assert.strictEqual(await Tracing.withObservation('off', () => { payloadReads++; }, null, () => 7), 7);
    assert.strictEqual(Workflow.recordSupply('id', 'purchase', () => { payloadReads++; }), null);
    assert.strictEqual(payloadReads, 0);
    assert.strictEqual(Tracing.observationStatus({ reason: 'schema_error' }), undefined);
    const BotManager = invoke('GameServer/Bot/BotManager');
    const originalInterval = global.setInterval;
    global.setInterval = () => { throw new Error('diagnostic timer off'); };
    try { BotManager.startStatusLogMonitor(); } finally { global.setInterval = originalInterval; }
    const Observer = invoke('WorldObserver/WorldObserverServer');
    const originalMemory = process.memoryUsage;
    process.memoryUsage = () => { throw new Error('diagnostic memory query off'); };
    try {
        assert.strictEqual(Observer.worldStatus().runtime, null);
        assert.deepStrictEqual(Observer.snapshotCacheStats(), { enabled: false });
    } finally { process.memoryUsage = originalMemory; }
    Config.developerDiagnostics = true;
    assert.strictEqual(cancelSkill(42).__packetTrace, 'actor=42');
    const onRoute = TownPathfinder.routeWithSession({}, null, origin, target);
    assert.deepStrictEqual(onRoute.to, offRoute.to, 'diagnostics must preserve native route choice');
    assert(onRoute.diagnostics);
    const liveSession = new Session({ write() {} });
    liveSession.recordOutboundPacket(Buffer.from([1]));
    assert.strictEqual(liveSession.packetTrace.length, 1);
    assert.strictEqual(liveSession.movementPacketTrace.length, 1);
    process.env.L2NODE_PACKET_TRACE = '0';
    liveSession.recordOutboundPacket(packet);
    assert.strictEqual(liveSession.movementPacketTrace.length, 1, 'subordinate flag covers movement too');
    MoveTo.recordMovementTrace(movement, { event: 'move' });
    assert.strictEqual(movement.movementTrace.length, 1);
    Config.developerDiagnostics = false;
    console.log('Developer diagnostic views checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
