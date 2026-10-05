require('./helpers/remainingProfessionHarness').runRoute(28).catch(error => {
    console.error(error); process.exitCode = 1;
});
