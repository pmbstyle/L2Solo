require('./helpers/remainingProfessionHarness').runRoute(9).catch(error => {
    console.error(error); process.exitCode = 1;
});
