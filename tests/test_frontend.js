// check the startup state without needing a browser
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("frontend/app.js", "utf8");

function run(saved) {
  const context = vm.createContext({
    localStorage: { getItem: () => saved, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, addEventListener() {} },
    console
  });
  vm.runInContext(source, context);
  return {
    count: vm.runInContext("cart.length", context),
    cart: vm.runInContext("JSON.stringify(cart)", context),
    declaration: value => vm.runInContext(
      "buildAllergenDeclaration(" + JSON.stringify(value) + ")", context
    )
  };
}

assert.equal(run("{invalid").count, 0);
assert.equal(run('{"items":[]}').count, 0);
assert.equal(run("null").count, 0);
assert.equal(run('[null,{"product_id":1,"quantity":2},{"product_id":2,"quantity":0}]').count, 1);
assert.equal(run('[{"product_id":1,"quantity":2}]').count, 1);
assert.equal(run("[]").declaration("Eggs"), "Contains: Eggs");
assert.equal(run("[]").declaration("No Allergens Present"),
  "Contains: None of the listed allergens");
console.log("frontend startup and allergen checks passed");
