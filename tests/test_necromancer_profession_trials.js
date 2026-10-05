require('./helpers/remainingProfessionHarness').runRoute(13).catch(error => {
    console.error(error); process.exitCode = 1;
});
