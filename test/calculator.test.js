import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCraftChain,
  calculateRecipe,
  createPriceIndex,
  effectiveReturnChance,
  extractCraftCatalog,
  normalizeOutput,
} from "../src/calculator.js";

test("effectiveReturnChance supports both current and legacy fields", () => {
  assert.equal(effectiveReturnChance({ return_chance_percent: 25, return_after_craft: false }), 25);
  assert.equal(effectiveReturnChance({ return_after_craft: true }), 100);
  assert.equal(effectiveReturnChance({ return_chance_percent: 150 }), 100);
  assert.equal(effectiveReturnChance({}), 0);
});

test("normalizeOutput computes the expected random output", () => {
  assert.deepEqual(normalizeOutput({ type: "rand", value: 78, min: 1, max: 4 }), {
    type: "rand",
    itemId: 78,
    min: 1,
    max: 4,
    expected: 2.5,
  });
  assert.deepEqual(normalizeOutput({ type: "const", value: 29, count: 4 }), {
    type: "const",
    itemId: 29,
    min: 4,
    max: 4,
    expected: 4,
  });
});

test("extractCraftCatalog skips disabled recipes and deduplicates equal building recipes", () => {
  const recipe = {
    id: 9,
    name: "iron_ingot",
    consume: [{ item_id: 28, quantity: 2, return_chance_percent: 0 }],
    result: [{ type: "const", value: 29, count: 1 }],
  };
  const catalog = extractCraftCatalog({
    buildings_craft: [
      { id: 7, receipts: [recipe] },
      { id: 601, receipts: [{ ...recipe, id: 99 }] },
      { id: 8, receipts: [{ ...recipe, id: 10, disabled: true }] },
    ],
  });

  assert.equal(catalog.get(29).length, 1);
  assert.deepEqual(catalog.get(29)[0].sourceBuildingIds, [7, 601]);
});

test("extractCraftCatalog includes disabled recipes enabled by a perk", () => {
  const catalog = extractCraftCatalog({
    buildings_craft: [{
      id: 606,
      receipts: [{
        id: 110,
        disabled: true,
        name: "toxic_mushroom",
        consume: [{ item_id: 107, quantity: 6 }],
        result: [{ type: "const", value: 129, count: 2 }],
      }],
    }],
  }, { enabledReceiptIds: [110] });

  assert.equal(catalog.get(129).length, 1);
  assert.equal(catalog.get(129)[0].recipeId, 110);
});

test("calculateRecipe uses sell prices for ingredients and buy prices for output", () => {
  const recipe = {
    outputItemId: 29,
    ingredients: [
      { itemId: 28, quantity: 2, returnChance: 0 },
      { itemId: 16, quantity: 1, returnChance: 75 },
    ],
    outputs: [{ type: "const", itemId: 29, min: 2, max: 2, expected: 2 }],
  };
  const prices = createPriceIndex({
    items: [
      { item_type_id: 28, best_sell_price: 10 },
      { item_type_id: 16, best_sell_price: 40 },
      { item_type_id: 29, best_buy_price: 30, best_sell_price: 35 },
    ],
  });
  const result = calculateRecipe(recipe, 3, prices);

  assert.equal(result.purchaseCost, 180);
  assert.equal(result.expectedCost, 90);
  assert.equal(result.expectedRevenue, 180);
  assert.equal(result.readyItemUnitPrice, 35);
  assert.equal(result.readyItemPurchaseCost, 210);
  assert.equal(result.savingsVsBuying, 120);
  assert.equal(result.unitCost, 15);
  assert.equal(result.profit, 90);
  assert.equal(result.ingredients[1].expectedConsumed, 0.75);
});

test("calculateRecipe does not expose a misleading total when a price is missing", () => {
  const recipe = {
    outputItemId: 3,
    ingredients: [
      { itemId: 1, quantity: 2, returnChance: 0 },
      { itemId: 2, quantity: 1, returnChance: 0 },
    ],
    outputs: [{ type: "const", itemId: 3, min: 1, max: 1, expected: 1 }],
  };
  const prices = new Map([[1, { sell: 5, buy: null }], [3, { sell: 20, buy: 15 }]]);
  const result = calculateRecipe(recipe, 1, prices);

  assert.equal(result.expectedCost, null);
  assert.equal(result.purchaseCost, null);
  assert.equal(result.coveredExpectedCost, 10);
  assert.equal(result.profit, null);
  assert.equal(result.costComplete, false);
});

test("calculateCraftChain recursively replaces craftable ingredients with raw materials", () => {
  const oreRecipe = {
    outputItemId: 2,
    selectedOutput: { type: "const", itemId: 2, min: 2, max: 2, expected: 2 },
    ingredients: [{ itemId: 1, quantity: 3, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 2, min: 2, max: 2, expected: 2 }],
  };
  const ingotRecipe = {
    outputItemId: 3,
    selectedOutput: { type: "const", itemId: 3, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 2, quantity: 4, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 3, min: 1, max: 1, expected: 1 }],
  };
  const prices = new Map([
    [1, { sell: 5, buy: 4 }],
    [2, { sell: 20, buy: 18 }],
    [3, { sell: 100, buy: 90 }],
  ]);
  const catalog = new Map([[2, [oreRecipe]], [3, [ingotRecipe]]]);
  const result = calculateCraftChain(ingotRecipe, 2, prices, catalog);

  assert.equal(result.craftSteps, 2);
  assert.equal(result.rawMaterials.length, 1);
  assert.equal(result.rawMaterials[0].itemId, 1);
  assert.equal(result.rawMaterials[0].quantity, 12);
  assert.equal(result.expectedCost, 60);
  assert.equal(result.expectedRevenue, 180);
  assert.equal(result.profit, 120);
  assert.equal(result.readyItemPurchaseCost, 200);
  assert.equal(result.savingsVsBuying, 140);
  assert.equal(result.root.children[0].craftRuns, 4);
  assert.equal(result.root.marketPurchaseCost, 200);
  assert.equal(result.root.children[0].marketPurchaseCost, 160);
});

test("calculateCraftChain chooses the cheapest complete recipe and applies returns", () => {
  const expensive = {
    outputItemId: 2,
    selectedOutput: { type: "const", itemId: 2, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 1, quantity: 5, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 2, min: 1, max: 1, expected: 1 }],
  };
  const cheap = {
    outputItemId: 2,
    selectedOutput: { type: "const", itemId: 2, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 1, quantity: 2, returnChance: 50 }],
    outputs: [{ type: "const", itemId: 2, min: 1, max: 1, expected: 1 }],
  };
  const root = {
    outputItemId: 3,
    selectedOutput: { type: "const", itemId: 3, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 2, quantity: 2, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 3, min: 1, max: 1, expected: 1 }],
  };
  const prices = new Map([
    [1, { sell: 10, buy: null }],
    [2, { sell: 15, buy: null }],
    [3, { sell: null, buy: 100 }],
  ]);
  const result = calculateCraftChain(root, 1, prices, new Map([[2, [expensive, cheap]]]));

  assert.equal(result.expectedCost, 20);
  assert.equal(result.rawMaterials[0].quantity, 2);
  assert.equal(result.root.children[0].recipe, cheap);
  assert.equal(result.root.children[0].cost, 20);
  assert.equal(result.root.children[0].marketPurchaseCost, 30);
});

test("calculateCraftChain falls back to the market when every nested recipe is incomplete", () => {
  const nested = {
    outputItemId: 2,
    selectedOutput: { type: "const", itemId: 2, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 99, quantity: 1, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 2, min: 1, max: 1, expected: 1 }],
  };
  const root = {
    outputItemId: 3,
    selectedOutput: { type: "const", itemId: 3, min: 1, max: 1, expected: 1 },
    ingredients: [{ itemId: 2, quantity: 2, returnChance: 0 }],
    outputs: [{ type: "const", itemId: 3, min: 1, max: 1, expected: 1 }],
  };
  const prices = new Map([[2, { sell: 7, buy: null }], [3, { sell: null, buy: 20 }]]);
  const result = calculateCraftChain(root, 1, prices, new Map([[2, [nested]]]));

  assert.equal(result.expectedCost, 14);
  assert.equal(result.root.children[0].kind, "market");
  assert.equal(result.root.children[0].reason, "recipe_incomplete");
});
