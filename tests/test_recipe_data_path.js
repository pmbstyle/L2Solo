const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

// A server or tool started outside the repo folder must still know the recipes.
const module_ = path.join(__dirname, '..', 'src', 'GameServer', 'Items', 'C4RecipeItems');
const script = `
    const recipes = require(${JSON.stringify(module_)});
    const recipe = recipes.resolveByRecipeId(1);
    process.stdout.write(JSON.stringify(recipe && recipe.productId));
`;
const out = execFileSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), encoding: 'utf8' });
assert.strictEqual(JSON.parse(out), 17, 'recipe 1 must resolve when the process starts outside the repo');

console.log('recipe data path checks passed');
