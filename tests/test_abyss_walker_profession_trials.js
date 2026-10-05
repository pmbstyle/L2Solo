require('./helpers/remainingProfessionHarness').runRoute(36).catch(error => {
    console.error(error); process.exitCode = 1;
});
