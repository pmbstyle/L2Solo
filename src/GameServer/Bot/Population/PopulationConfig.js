const PopulationConfig = {
    enabled: true,
    backgroundResolverEnabled: true,
    phasePolicyEnabled: true,
    directorEnabled: true,
    summaryIntervalMs: 30000,
    schedulerIntervalMs: 5000,
    phasePolicyIntervalMs: 10000,
    directorIntervalMs: 30000,
    maxResolvesPerTick: 10,
    cooldownGraceMs: 25000,
    cooldownBatchSize: 20,
    activationRadius: 6000,
    maxActivationsPerScan: 12,
    directorTargetBandRadius: 2,
    directorMaxCatchUpMultiplier: 1.35,
    directorSlowdownMultiplier: 0.85,
    eventLoopSampleMs: 1000,
    slowEventLoopLagMs: 75,
    debug: false
};

module.exports = PopulationConfig;
