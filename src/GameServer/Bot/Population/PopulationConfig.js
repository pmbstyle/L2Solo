const PopulationConfig = {
    enabled: true,
    backgroundResolverEnabled: true,
    phasePolicyEnabled: true,
    summaryIntervalMs: 30000,
    schedulerIntervalMs: 5000,
    phasePolicyIntervalMs: 10000,
    maxResolvesPerTick: 10,
    cooldownGraceMs: 25000,
    cooldownBatchSize: 20,
    activationRadius: 6000,
    maxActivationsPerScan: 12,
    eventLoopSampleMs: 1000,
    slowEventLoopLagMs: 75,
    debug: false
};

module.exports = PopulationConfig;
