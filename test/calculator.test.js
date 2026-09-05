import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateCraftChain,
  calculateRecipe,
  createItemIndex,
  createPriceIndex,
  getEffectiveBuyPrice,
  describeHarvestReceipt,
  effectiveReturnChance,
  extractHarvestCatalog,
  extractCraftCatalog,
  calculateHarvest,
  normalizeOutput,
} from "../src/calculator.js";

const sampleConfig = JSON.parse(await readFile(new URL("../sample/configs.json", import.meta.url), "utf8"));

test("extractHarvestCatalog excludes disabled receipts and candidates", () => {
  const catalog = extractHarvestCatalog({
    harvests: [{
      receipt_id: 1,
      items_slots: [{ available_items: [
        { item_id: 2, count: 1 },
        { item_id: 3, count: 1, disabled: true },
      ] }],
      result: [{ item_id: 4, count: 1, chance_percent: 100 }],
    }, {
      receipt_id: 2,
      disabled: true,
      items_slots: [{ available_items: [{ item_id: 2, count: 1 }] }],
      result: [{ item_id: 4, count: 1, chance_percent: 100 }],
    }],
  });

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].slots[0].candidates.length, 1);
  assert.equal(catalog[0].slots[0].candidates[0].breakChance, 0);
  assert.equal(catalog[0].slots[0].candidates[0].lootmoreCoef, 1);
});

test("calculateHarvest applies sample receipt 42 Mecha Cart bonus with a 100% cap", () => {
  const receipt = extractHarvestCatalog(sampleConfig).find((entry) => entry.receiptId === 42);
  const selectedCandidates = receipt.slots.map((slot) => {
    const cartIndex = slot.candidates.findIndex((candidate) => candidate.itemId === 106);
    return cartIndex >= 0 ? cartIndex : 0;
  });
  const cart = receipt.slots.flatMap((slot) => slot.candidates).find((candidate) => candidate.itemId === 106);
  assert.equal(cart.lootmoreCoef, 1.75);
  const prices = new Map([[176, { buy: 10 }], [178, { buy: 100 }], [35, { buy: 20 }]]);
  const ordinary = calculateHarvest(receipt, 2, prices);
  const result = calculateHarvest(receipt, 2, prices, selectedCandidates);

  assert.deepEqual(ordinary.outputs.map((output) => output.chance), [65, 0.25, 65]);
  assert.deepEqual(result.outputs.map((output) => output.baseChance), [65, 0.25, 65]);
  assert.deepEqual(result.outputs.map((output) => output.chance), [100, 0.4375, 100]);
  assert.deepEqual(result.outputs.map((output) => output.expected), [6, 0.00875, 6]);
  assert.equal(result.expectedRevenue, 180.875);
});

test("calculateHarvest combines selected slot bonuses after selectable sharing and propagates bundle revenue", () => {
  const [receipt] = extractHarvestCatalog({ harvests: [{
    receipt_id: 90,
    items_slots: [
      { name: "worker", available_items: [{ item_id: 10, lootmore_coef: 1.5 }] },
      { name: "transporter", available_items: [
        { item_id: 11 }, { item_id: 12, lootmore_coef: 2 },
      ] },
      { name: "tool", available_items: [{ item_id: 13 }] },
      { name: "empty", available_items: [] },
    ],
    result: [
      { item_id: 143, count: 2, chance_percent: 60, selectable: true },
      { item_id: 21, count: 1, chance_percent: 80, selectable: true },
      { item_id: 22, count: 1, chance_percent: 50, selectable: true },
      { item_id: 23, count: 1, chance_percent: 0 },
    ],
  }] });
  const prices = new Map([[107, { buy: 10 }], [21, { buy: 5 }]]);
  const itemIndex = new Map([[143, { bundle: "107x3" }]]);
  const result = calculateHarvest(receipt, 2, prices, [0, 1], new Set(["90:0", "90:1"]), new Map(), itemIndex);

  assert.deepEqual(result.outputs.map((output) => output.chance), [90, 100, 0, 0]);
  assert.equal(result.outputs[0].baseChance, 60);
  assert.equal(result.outputs[0].expected, 3.6);
  assert.equal(result.outputs[0].children[0].chance, 90);
  assert.ok(Math.abs(result.outputs[0].children[0].expected - 10.8) < 1e-12);
  assert.equal(result.outputs[1].expected, 2);
  assert.equal(result.outputs[2].expected, 0);
  assert.equal(result.outputs[3].expected, 0);
  assert.ok(Math.abs(result.expectedRevenue - 118) < 1e-12);

  const fallback = calculateHarvest(receipt, 1, prices, [99, 99], new Set(["90:0", "90:1"]), new Map(), itemIndex);
  assert.deepEqual(fallback.outputs.map((output) => output.chance), [45, 60, 0, 0]);
  const unchecked = calculateHarvest(receipt, 1, prices, [0, 1], new Set(), new Map(), itemIndex);
  assert.deepEqual(unchecked.outputs.map((output) => output.chance), [0, 0, 0, 0]);
  assert.equal(unchecked.expectedRevenue, 0);
});

test("extractHarvestCatalog keeps valid zero-chance results", () => {
  const catalog = extractHarvestCatalog({
    harvests: [{
      receipt_id: 3,
      result: [
        { item_id: 4, count: 2, chance_percent: 0 },
        { item_id: 5, count: 0, chance_percent: 100 },
      ],
    }],
  });

  assert.deepEqual(catalog[0].results, [{
    key: "3:0",
    itemId: 4,
    count: 2,
    chance: 0,
    selectable: false,
  }]);
  const calculation = calculateHarvest(catalog[0], 1, new Map());
  assert.equal(calculation.outputs[0].expected, 0);
});

test("calculateHarvest prices candidate consumption, requirements, and selected results", () => {
  const receipt = {
    receiptId: 8,
    slots: [{ candidates: [{
      itemId: 10,
      count: 2,
      breakChance: 25,
      requirements: [{ itemId: 11, quantity: 3 }],
    }] }],
    results: [
      { itemId: 20, count: 2, chance: 50, selectable: true },
      { itemId: 21, count: 1, chance: 100, selectable: false },
    ],
  };
  const prices = new Map([
    [10, { sell: 8 }], [11, { sell: 4 }], [20, { buy: 30 }], [21, { buy: 5 }],
  ]);
  const result = calculateHarvest(receipt, 2, prices, [], new Set([20]));

  assert.equal(result.ingredients.find((item) => item.itemId === 10).quantity, 4);
  assert.equal(result.ingredients.find((item) => item.itemId === 10).returnChance, 75);
  assert.equal(result.ingredients.find((item) => item.itemId === 10).expectedConsumed, 1);
  assert.equal(result.ingredients.find((item) => item.itemId === 11).quantity, 6);
  assert.equal(result.expectedCost, 32);
  assert.equal(result.outputs.find((item) => item.itemId === 20).expected, 2);
  assert.equal(result.outputs.find((item) => item.itemId === 20).unitPrice, 30);
  assert.equal(result.outputs.find((item) => item.itemId === 20).revenue, 60);
  assert.equal(result.outputs.find((item) => item.itemId === 21).expected, 2);
  assert.equal(result.expectedRevenue, 70);
  assert.equal(result.profit, 38);
});

test("calculateHarvest keeps sample receipt 3 teachers when break chance is absent and consumes students and requirements", () => {
  const receipt = extractHarvestCatalog(sampleConfig).find((entry) => entry.receiptId === 3);
  const prices = new Map([[1, { sell: 2 }], [22, { sell: 5 }]]);
  for (const teacherId of [9, 42]) {
    const selectedCandidates = receipt.slots.map((slot) => Math.max(0,
      slot.candidates.findIndex((candidate) => candidate.itemId === teacherId)));
    const result = calculateHarvest(receipt, 2, prices, selectedCandidates);
    const teacher = result.ingredients.find((item) => item.itemId === teacherId);
    assert.equal(teacher.quantity, 2);
    assert.equal(teacher.returnChance, 100);
    assert.equal(teacher.expectedConsumed, 0);
    assert.equal(teacher.expectedCost, 0);
    assert.equal(teacher.purchaseCost, 0);
    const student = result.ingredients.find((item) => item.itemId === 22);
    assert.equal(student.quantity, 2);
    assert.equal(student.returnChance, 0);
    assert.equal(student.expectedConsumed, 2);
    const requirement = result.ingredients.find((item) => item.itemId === 1);
    assert.equal(requirement.quantity, 2);
    assert.equal(requirement.returnChance, 0);
    assert.equal(requirement.expectedConsumed, 2);
    assert.equal(result.costComplete, true);
    assert.equal(result.expectedCost, 14);
    assert.equal(result.purchaseCost, 14);
  }
});

test("calculateHarvest exposes sample receipt 28 gross quantities and return chances", () => {
  const receipt = extractHarvestCatalog(sampleConfig).find((entry) => entry.receiptId === 28);
  const prices = new Map([[14, { sell: 100 }], [86, { sell: 50 }],
    [1, { sell: 2 }], [2, { sell: 3 }], [166, { sell: 4 }]]);
  for (const runs of [1, 3]) {
    const result = calculateHarvest(receipt, runs, prices);
    for (const itemId of [14, 86]) {
      const ingredient = result.ingredients.find((item) => item.itemId === itemId);
      assert.equal(ingredient.quantity, runs);
      assert.equal(ingredient.returnChance, 96);
      assert.equal(ingredient.expectedConsumed, 0.04 * runs);
    }
    const requirement = result.ingredients.find((item) => item.itemId === 1);
    assert.equal(requirement.quantity, 4 * runs);
    assert.equal(requirement.returnChance, 0);
    assert.equal(requirement.expectedConsumed, 4 * runs);
    assert.equal(result.expectedCost, 30 * runs);
    assert.equal(result.purchaseCost, 30 * runs);

    const output = { type: "const", itemId: 110, min: 1, max: 1, expected: 1 };
    const chain = calculateCraftChain({
      outputItemId: 110, selectedOutput: output, outputs: [output],
      ingredients: result.ingredients,
    }, 1, prices, new Map());
    assert.ok(Math.abs(chain.expectedCost - result.expectedCost) < 1e-10);
    assert.ok(Math.abs(chain.rawMaterials.find((item) => item.itemId === 14).quantity - 0.04 * runs) < 1e-12);
  }
});

test("calculateHarvest combines material quantities with weighted returns and keeps unbreakable equipment", () => {
  const [receipt] = extractHarvestCatalog({ harvests: [{
    receipt_id: 91,
    items_slots: [
      { available_items: [{ item_id: 10, count: 2, break_percent: 25,
        requirements: [{ item_id: 10, count: 1 }] }] },
      { available_items: [{ item_id: 10, count: 1, break_percent: 50 }] },
      { available_items: [{ item_id: 11, count: 1, break_percent: 0 }] },
    ],
    result: [{ item_id: 20, count: 1, chance_percent: 100 }],
  }] });
  const result = calculateHarvest(receipt, 3, new Map([[10, { sell: 8 }], [20, { buy: 20 }]]));
  assert.equal(result.ingredients.length, 2);
  const combined = result.ingredients.find((item) => item.itemId === 10);
  assert.equal(combined.quantity, 12);
  assert.equal(combined.expectedConsumed, 6);
  assert.equal(combined.returnChance, 50);
  assert.equal(combined.expectedCost, 48);
  const unbreakable = result.ingredients.find((item) => item.itemId === 11);
  assert.equal(unbreakable.quantity, 3);
  assert.equal(unbreakable.returnChance, 100);
  assert.equal(unbreakable.expectedConsumed, 0);
  assert.equal(unbreakable.unitPrice, null);
  assert.equal(unbreakable.expectedCost, 0);
  assert.equal(unbreakable.purchaseCost, 0);
  assert.equal(result.costComplete, true);
  assert.equal(result.purchaseComplete, true);
  assert.equal(result.expectedCost, 48);
  assert.equal(result.purchaseCost, 48);
  assert.equal(result.profit, 12);
});

test("calculateHarvest excludes selectable results from expected sale while retaining rows", () => {
  const result = calculateHarvest({
    receiptId: 17,
    slots: [],
    results: [
      { key: "17:0", itemId: 20, count: 2, chance: 50, selectable: true },
      { key: "17:1", itemId: 20, count: 1, chance: 0, selectable: false },
    ],
  }, 3, new Map([[20, { buy: 10 }]]), [], new Set());

  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs[0].expected, 0);
  assert.equal(result.outputs[0].revenue, 0);
  assert.equal(result.outputs[1].expected, 0);
  assert.equal(result.outputs[1].revenue, 0);
  assert.equal(result.expectedRevenue, 0);
});

test("calculateHarvest splits selectable chance across checked results", () => {
  const receipt = {
    receiptId: 19,
    slots: [],
    results: [
      { key: "19:0", itemId: 20, count: 1, chance: 3, selectable: true },
      { key: "19:1", itemId: 21, count: 1, chance: 1, selectable: true },
      { key: "19:2", itemId: 22, count: 1, chance: 100, selectable: false },
    ],
  };
  const result = calculateHarvest(receipt, 2, new Map([
    [20, { buy: 10 }], [21, { buy: 20 }], [22, { buy: 1 }],
  ]), [], new Set(["19:0", "19:1"]));

  assert.equal(result.outputs[0].chance, 1.5);
  assert.equal(result.outputs[0].baseChance, 3);
  assert.equal(result.outputs[0].expected, 0.03);
  assert.equal(result.outputs[1].chance, 0.5);
  assert.equal(result.outputs[1].expected, 0.01);
  assert.equal(result.expectedRevenue, 2.5);
});

test("calculateHarvest expands sample RollerEvilDoctor output into priced children", () => {
  const receipt = extractHarvestCatalog(sampleConfig).find((entry) => entry.receiptId === 18);
  const itemIndex = createItemIndex(sampleConfig.items);
  const result = calculateHarvest(receipt, 1, new Map([
    [61, { buy: 10 }], [71, { buy: 20 }], [73, { buy: 30 }],
  ]), [], new Set(["18:1"]), new Map(), itemIndex);

  const roller = result.outputs.find((output) => output.itemId === 66);
  assert.equal(roller.chance, 1);
  assert.deepEqual(roller.children.map((child) => [child.itemId, child.expected]), [
    [61, 0.04], [71, 0.02], [73, 0.04],
  ]);
  assert.deepEqual(roller.children.map((child) => [child.unitPrice, child.revenue]), [
    [10, 0.4], [20, 0.4], [30, 1.2],
  ]);
  assert.equal(roller.revenue, 2);
  assert.equal(result.expectedRevenue, 5);
});

test("calculateHarvest uses best buy prices for regular result market values", () => {
  const result = calculateHarvest({
    receiptId: 22,
    slots: [],
    results: [{ itemId: 44, count: 2, chance: 100, selectable: false }],
  }, 3, new Map([[44, { buy: 17, sell: 99 }]]));

  assert.equal(result.outputs[0].unitPrice, 17);
  assert.equal(result.outputs[0].revenue, 102);
  assert.equal(result.expectedRevenue, 102);
});

test("calculateHarvest applies assumed buy prices to regular and bundle child results", () => {
  const result = calculateHarvest({
    receiptId: 23,
    slots: [],
    results: [{ itemId: 143, count: 1, chance: 100, selectable: false }],
  }, 2, new Map([[143, { buy: 10 }], [107, { buy: 4 }]]), [], new Set(), new Map([[107, 9]]), new Map([
    [143, { bundle: "107x3" }],
  ]));

  assert.equal(result.outputs[0].unitPrice, 10);
  assert.equal(result.outputs[0].revenue, 54);
  assert.equal(result.outputs[0].children[0].unitPrice, 9);
  assert.equal(result.outputs[0].children[0].marketUnitPrice, 4);
  assert.equal(result.expectedRevenue, 54);
  assert.equal(getEffectiveBuyPrice(107, new Map([[107, { buy: 4 }]]), new Map([[107, 9]])), 9);
});

test("createPriceIndex uses marketplace item_type_id and preserves missing buy prices", () => {
  const prices = createPriceIndex({ items: [
    { item_type_id: 20, best_buy_price: 12, best_sell_price: 15 },
    { item_type_id: 21, item_id: 999, best_sell_price: 8 },
    { item_type_id: 22, best_buy_price: "invalid" },
  ] });

  assert.deepEqual(prices.get(20), { buy: 12, sell: 15 });
  assert.deepEqual(prices.get(21), { buy: null, sell: 8 });
  assert.deepEqual(prices.get(22), { buy: null, sell: null });
  assert.equal(prices.has(999), false);
});

test("Harvest chain expands sample Stone Axe materials and totals selected expected sale", () => {
  const harvestReceipt = extractHarvestCatalog(sampleConfig).find((receipt) => receipt.receiptId === 1);
  const craftCatalog = extractCraftCatalog(sampleConfig);
  const prices = new Map([
    [1, { sell: 2, buy: 3 }],
    [3, { sell: 4, buy: 10 }],
    [5, { sell: 5, buy: 11 }],
    [6, { sell: 6, buy: 12 }],
    [4, { sell: 4, buy: 10 }],
    [17, { sell: 7, buy: 13 }],
  ]);
  const harvest = calculateHarvest(harvestReceipt, 1, prices, [], new Set(["1:0"]));
  const output = {
    type: "const",
    itemId: harvest.outputs[0].itemId,
    min: 1,
    max: 1,
    expected: 1,
  };
  const chain = calculateCraftChain({
    outputItemId: output.itemId,
    ingredients: harvest.ingredients,
    outputs: [output],
    selectedOutput: output,
    recipeName: "Harvest materials",
  }, 1, prices, craftCatalog);

  assert.equal(harvest.outputs[0].baseChance, 225);
  assert.equal(harvest.outputs[0].chance, 100);
  assert.equal(harvest.expectedRevenue, 18.25);
  assert.equal(harvest.outputs[1].selected, true);
  assert.equal(chain.root.children.find((child) => child.itemId === 17)?.recipe.outputItemId, 17);
});

test("calculateHarvest removes excluded selectable rows from expected sale totals", () => {
  const receipt = {
    receiptId: 18,
    slots: [],
    results: [
      { key: "18:0", itemId: 20, count: 2, chance: 50, selectable: true },
      { key: "18:1", itemId: 21, count: 1, chance: 100, selectable: false },
    ],
  };
  const prices = new Map([[20, { buy: 10 }], [21, { buy: 4 }]]);
  const selected = calculateHarvest(receipt, 2, prices, [], new Set(["18:0"]));
  const excluded = calculateHarvest(receipt, 2, prices, [], new Set());

  assert.deepEqual(selected.outputs.map((output) => output.expected), [2, 2]);
  assert.equal(selected.expectedRevenue, 28);
  assert.equal(excluded.expectedRevenue, 8);
  assert.equal(excluded.outputs[0].selected, false);
});

test("calculateHarvest keeps every output in the result tree when one is excluded", () => {
  const result = calculateHarvest({
    receiptId: 13,
    slots: [{ candidates: [{ itemId: 10, count: 1, breakChance: 100, requirements: [] }] }],
    results: [
      { itemId: 20, count: 2, chance: 50, selectable: true },
      { itemId: 21, count: 1, chance: 100, selectable: true },
    ],
  }, 2, new Map([[10, { sell: 1 }], [20, { buy: 4 }], [21, { buy: 5 }]]), [], new Set([20]));

  assert.deepEqual(result.outputs.map((output) => output.itemId), [20, 21]);
  assert.equal(result.outputs.find((output) => output.itemId === 21).selected, false);
  assert.equal(result.outputs.find((output) => output.itemId === 21).expected, 0);
  assert.deepEqual(result.root.children.map((output) => output.itemId), [20, 21]);
});

test("calculateHarvest selects duplicate item results independently by result key", () => {
  const receipt = {
    key: "14",
    receiptId: 14,
    slots: [],
    results: [
      { key: "14:0", itemId: 20, count: 1, chance: 50, selectable: true },
      { key: "14:1", itemId: 20, count: 2, chance: 25, selectable: true },
    ],
  };

  const result = calculateHarvest(receipt, 2, new Map([[20, { buy: 10 }]]), [], new Set(["14:1"]));

  assert.equal(result.outputs[0].selected, false);
  assert.equal(result.outputs[0].expected, 0);
  assert.equal(result.outputs[1].selected, true);
  assert.equal(result.outputs[1].expected, 1);
});

test("calculateHarvest does not link duplicate item results through the legacy item ID selection", () => {
  const receipt = {
    key: "15",
    receiptId: 15,
    slots: [],
    results: [
      { key: "15:0", itemId: 20, count: 1, chance: 50, selectable: true },
      { key: "15:1", itemId: 20, count: 2, chance: 25, selectable: true },
    ],
  };

  const result = calculateHarvest(receipt, 1, new Map([[20, { buy: 10 }]]), [], new Set([20]));

  assert.equal(result.outputs[0].selected, false);
  assert.equal(result.outputs[1].selected, false);
});

test("calculateHarvest treats missing prices as zero revenue for zero-chance outputs", () => {
  const result = calculateHarvest({
    receiptId: 16,
    slots: [],
    results: [{ itemId: 20, count: 1, chance: 0, selectable: false }],
  }, 1, new Map());

  assert.equal(result.outputs[0].expected, 0);
  assert.equal(result.outputs[0].revenue, 0);
  assert.equal(result.revenueComplete, true);
  assert.equal(result.expectedRevenue, 0);
  assert.equal(result.profit, 0);
});

test("describeHarvestReceipt explains every candidate, requirements, results, and fallback item IDs", () => {
  const description = describeHarvestReceipt({
    slots: [{ name: "worker", candidates: [
      { itemId: 99, breakChance: 25, requirements: [{ itemId: 100, quantity: 3 }] },
      { itemId: 102, breakChance: 80, requirements: [] },
    ] }],
    results: [{ itemId: 101, chance: 37, selectable: true }],
  }, {
    itemName: (itemId) => `Item #${itemId}`,
    translate: (key) => key === "worker" ? "Worker" : key,
  });

  assert.match(description, /Worker candidates:.*Item #99.*break chance 25%.*Item #100 \(#100\) x 3/);
  assert.match(description, /Item #102.*break chance 80%.*requirements: none/);
  assert.match(description, /Item #101 \(#101\) at 37% chance, selectable: true/);
  assert.match(description, /approximation/);
});

test("calculateHarvest evaluates every slot with explicit 100% break chance", () => {
  const receipt = {
    receiptId: 9,
    slots: [
      { candidates: [{ itemId: 10, count: 2, breakChance: 100, requirements: [] }] },
      { candidates: [{ itemId: 11, count: 3, breakChance: 100, requirements: [] }] },
    ],
    results: [{ itemId: 20, count: 1, chance: 100, selectable: false }],
  };
  const result = calculateHarvest(receipt, 1, new Map([
    [10, { sell: 2 }], [11, { sell: 3 }], [20, { buy: 5 }],
  ]));

  assert.equal(result.ingredients.find((item) => item.itemId === 10).quantity, 2);
  assert.equal(result.ingredients.find((item) => item.itemId === 11).quantity, 3);
});

test("calculateHarvest prefers assumed prices for material costs", () => {
  const receipt = {
    receiptId: 12,
    slots: [{ candidates: [{ itemId: 10, count: 2, breakChance: 50, requirements: [
      { itemId: 11, quantity: 1 },
    ] }] }],
    results: [{ itemId: 20, count: 1, chance: 100, selectable: false }],
  };
  const prices = new Map([
    [10, { sell: 8 }], [11, { sell: 4 }], [20, { buy: 10 }],
  ]);
  const result = calculateHarvest(receipt, 2, prices, [], new Set(), new Map([
    [10, 3], [11, 7],
  ]));

  assert.equal(result.ingredients.find((item) => item.itemId === 10).marketUnitPrice, 8);
  assert.equal(result.ingredients.find((item) => item.itemId === 10).unitPrice, 3);
  assert.equal(result.ingredients.find((item) => item.itemId === 11).unitPrice, 7);
  assert.equal(result.expectedCost, 20);
});

test("calculateHarvest accepts no selectable results and ignores unrelated duration settings", () => {
  const receipt = {
    receiptId: 10,
    slots: [{ candidates: [{ itemId: 10, count: 1, breakChance: 100, requirements: [] }] }],
    results: [
      { itemId: 20, count: 1, chance: 100, selectable: true },
      { itemId: 21, count: 1, chance: 100, selectable: false },
    ],
    duration: 999,
    max_parallel: 99,
  };
  const result = calculateHarvest(receipt, 2, new Map([[10, { sell: 4 }], [20, { buy: 8 }], [21, { buy: 3 }]]), [0], new Set());

  assert.equal(result.outputs.find((output) => output.itemId === 20).expected, 0);
  assert.equal(result.outputs.find((output) => output.itemId === 21).expected, 2);
  assert.equal(result.expectedRevenue, 6);
});

test("calculateHarvest hides cost when a material price is missing", () => {
  const receipt = {
    receiptId: 11,
    slots: [{ candidates: [{ itemId: 10, count: 2, breakChance: 100, requirements: [] }] }],
    results: [{ itemId: 20, count: 1, chance: 100, selectable: false }],
  };
  const result = calculateHarvest(receipt, 1, new Map([[20, { buy: 7 }]]));

  assert.equal(result.expectedCost, null);
  assert.equal(result.coveredExpectedCost, 0);
  assert.equal(result.profit, null);
});

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

test("calculateRecipe prefers assumed ingredient prices when provided", () => {
  const recipe = {
    outputItemId: 3,
    ingredients: [
      { itemId: 1, quantity: 2, returnChance: 0 },
      { itemId: 2, quantity: 1, returnChance: 0 },
    ],
    outputs: [{ type: "const", itemId: 3, min: 1, max: 1, expected: 1 }],
  };
  const prices = new Map([
    [1, { sell: 5, buy: 4 }],
    [2, { sell: 8, buy: 7 }],
    [3, { sell: 20, buy: 18 }],
  ]);
  const result = calculateRecipe(recipe, 1, prices, new Map([[1, 4], [2, 12]]));

  assert.equal(result.expectedCost, 20);
  assert.equal(result.ingredients[0].unitPrice, 4);
  assert.equal(result.ingredients[1].unitPrice, 12);
});

test("calculateCraftChain uses assumed prices when expanding raw materials", () => {
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
  const result = calculateCraftChain(ingotRecipe, 2, prices, catalog, { maxDepth: 12 }, new Map([[1, 2]]));

  assert.equal(result.expectedCost, 24);
  assert.equal(result.rawMaterials[0].quantity, 12);
  assert.equal(result.rawMaterials[0].unitPrice, 2);
  assert.equal(result.root.children[0].cost, 24);
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
