import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("Craft unlock perks apply only in Craft while mode switching selects the visible perk group", () => {
  const source = mainSource.match(/function enabledReceiptIds\(\) \{[^]*?\n\}/)[0];
  const state = { calculatorMode: "craft", perkIds: new Set([1]) };
  const enabled = new Function("state", "recipeUnlockPerks", `${source}; return enabledReceiptIds;`)(state,
    () => [{ id: 1, effects: [{ Target: { BuildingTarget: { receipt_id: 42 } }, Effect: { CraftEnableReceipt: {} } }] }]);
  assert.deepEqual(enabled(), [42]);
  state.calculatorMode = "harvest";
  assert.deepEqual(enabled(), []);
  state.calculatorMode = "craft";
  assert.deepEqual(enabled(), [42]);
  const modeSource = mainSource.match(/function setCalculatorMode\(mode\) \{[^]*?\n\}/)[0];
  assert.match(modeSource, /elements\.craftPerks\.hidden = isHarvest;/);
  assert.match(modeSource, /elements\.rewardPerkList\.hidden = !isHarvest;/);
  assert.match(modeSource, /rebuildCatalog\(\);/);
  assert.match(htmlSource, /id="rewardPerkList" hidden/);
});

test("Harvest perk checkboxes preserve selections and recalculate without changing Craft perks", () => {
  const source = mainSource.match(/function populateHarvestPerks\(receipt\) \{[^]*?\n\}/)[0];
  const makeElement = () => ({ children: [], append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    addEventListener(event, listener) { this[event] = listener; } });
  const document = { createElement: makeElement, createTextNode: (text) => text };
  const state = { rewardPerkIds: new Set([11]), perkIds: new Set([99]) };
  const elements = { rewardPerkList: makeElement() };
  let renders = 0;
  const populate = new Function("document", "state", "elements", "translate", "renderCalculation",
    `${source}; return populateHarvestPerks;`)(document, state, elements, (name) => name, () => { renders += 1; });
  const receipt = { rewardPerks: [{ id: 11, name: "Boss slayer" }] };
  populate(receipt);
  const checkbox = elements.rewardPerkList.children[0].children[2].children[0].children[0];
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  checkbox.change();
  assert.equal(state.rewardPerkIds.has(11), false);
  checkbox.checked = true;
  checkbox.change();
  assert.equal(state.rewardPerkIds.has(11), true);
  assert.equal(renders, 2);
  assert.deepEqual([...state.perkIds], [99]);
  populate({ rewardPerks: [] });
  assert.equal(elements.rewardPerkList.children.length, 0);
  populate(receipt);
  assert.equal(elements.rewardPerkList.children[0].children[2].children[0].children[0].checked, true);
});

test("Harvest shard slots restore duplicate choices within the slot limit and refresh calculation", () => {
  const source = mainSource.match(/function populateHarvestShards\(receipt, selection\) \{[^]*?\n\}/)[0];
  const makeElement = () => ({ children: [], append(...children) { this.children.push(...children); },
    addEventListener(event, listener) { this[event] = listener; } });
  const document = { createElement: makeElement };
  const elements = { harvestOptions: makeElement() };
  let updates = 0;
  let renders = 0;
  const populate = new Function("document", "elements", "setOption", "itemName", "formatQuantity",
    "populateHarvestOptions", "renderCalculation", `${source}; return populateHarvestShards;`)(
    document, elements, (select, value, text) => select.append({ value, text }), String, String,
    () => { updates += 1; }, () => { renders += 1; });
  const receipt = { shardSlots: 2, shards: [
    { itemId: 88, durationSec: 300 }, { itemId: 129, durationSec: 900 },
  ] };
  const selection = { shards: [88, 88, 129] };
  populate(receipt, selection);
  assert.deepEqual(selection.shards, [88, 88]);
  const secondSelect = elements.harvestOptions.children[2].children[1];
  assert.notEqual(secondSelect.children[1].disabled, true);
  secondSelect.value = "129";
  secondSelect.change();
  assert.deepEqual(selection.shards, [88, 129]);
  assert.equal(updates, 1);
  assert.equal(renders, 1);
  populate({ shardSlots: 1, shards: [{ itemId: 129, durationSec: 900 }] }, selection);
  assert.deepEqual(selection.shards, [0]);
  populate({}, selection);
  assert.deepEqual(selection.shards, []);
});

test("harvest receipt search matches output names and recovers from no matches", () => {
  const population = mainSource.match(/function populateHarvestReceipts\([^]*?\n\}/);
  assert.ok(population, "harvest receipt population function exists");
  const state = {
    harvestCatalog: [
      { key: "harvest:24", receiptId: 24, results: [{ itemId: 1 }] },
      { key: "harvest:25", receiptId: 25, results: [{ itemId: 99 }, { itemId: 37 }] },
      { key: "harvest:26", receiptId: 26, results: [] },
    ],
  };
  const itemNames = new Map([[1, "Wood"], [99, "Shell"], [37, "Salt"]]);
  const elements = {
    itemSelect: {
      options: [],
      value: "",
      disabled: false,
      replaceChildren() { this.options = []; this.value = ""; },
    },
    harvestOptions: {
      children: ["previous options"],
      replaceChildren() { this.children = []; },
    },
    harvestReceiptSummary: { hidden: false },
    results: { hidden: false },
  };
  let renders = 0;
  const populate = new Function(
    "state", "elements", "itemName", "setOption", "populateHarvestOptions", "renderCalculation",
    `${population[0]}; return populateHarvestReceipts;`,
  )(
    state, elements, (id) => itemNames.get(id) ?? `Item #${id}`,
    (select, value, label) => select.options.push({ value, label }),
    () => {}, () => { renders += 1; },
  );

  for (const search of ["Shell", "shell", "  SHELL  ", "hel", "Salt", "25", "receipt 25"]) {
    populate(search);
    assert.deepEqual(elements.itemSelect.options, [
      { value: "harvest:25", label: "Receipt #25 — Shell / Salt" },
    ], search);
    assert.equal(elements.itemSelect.value, "harvest:25");
    assert.equal(elements.itemSelect.disabled, false);
    assert.equal(elements.results.hidden, false);
  }

  const rendersBeforeNoMatch = renders;
  populate("unknown output");
  assert.deepEqual(elements.itemSelect.options, [{ value: "", label: "No receipts found" }]);
  assert.equal(elements.itemSelect.disabled, true);
  assert.equal(elements.results.hidden, true);
  assert.deepEqual(elements.harvestOptions.children, []);
  assert.equal(renders, rendersBeforeNoMatch);

  populate("", "harvest:25");
  assert.equal(elements.itemSelect.options.length, 3);
  assert.equal(elements.itemSelect.value, "harvest:25");
  assert.equal(elements.itemSelect.disabled, false);
  assert.equal(elements.results.hidden, false);
  assert.equal(renders, rendersBeforeNoMatch + 1);

  state.harvestCatalog = [];
  populate("");
  assert.equal(elements.itemSelect.disabled, true);
  assert.equal(elements.results.hidden, true);
});

test("harvest receipt population rerenders the selected receipt", () => {
  assert.match(mainSource, /populateHarvestOptions\(\);\s*elements\.results\.hidden = false;\s*renderCalculation\(\);/);
  assert.match(mainSource, /Receipt #\$\{receipt\.receiptId\} — \$\{receipt\.results\.map/);
  assert.match(mainSource, /className = "harvest-results-table"/);
  assert.doesNotMatch(mainSource, /収穫物/);
});

test("harvest uses the shared craft chain calculator for chain materials", () => {
  assert.match(mainSource, /const chainCalculation = calculateCraftChain\(/);
  assert.match(mainSource, /const isChain = state\.costMode === "chain";/);
  assert.doesNotMatch(mainSource, /materialTree|makeHarvestMaterialNode|harvestChainModeButton/);
});

test("harvest mode uses harvest labels and hides crafting savings", () => {
  assert.match(htmlSource, /id="calculatorTitle"/);
  assert.match(htmlSource, /id="runsLabel"/);
  assert.match(htmlSource, /id="resultLabel"/);
  assert.match(mainSource, /elements\.calculatorTitle\.textContent = isHarvest \? "Harvest calculator" : "Crafting calculator";/);
  assert.match(mainSource, /elements\.runsLabel\.textContent = isHarvest \? "Runs" : "Crafts";/);
  assert.match(mainSource, /elements\.resultLabel\.textContent = isHarvest \? "Harvest result" : "Crafting result";/);
  assert.match(mainSource, /elements\.savingsMetric\.hidden = isHarvest;/);
});

test("harvest mode hides finished-item comparison and uses harvest metric labels", () => {
  assert.match(htmlSource, /id="marketPurchaseMetric"/);
  assert.match(htmlSource, /id="expectedCostHint">including ingredient returns<\/small>/);
  assert.match(mainSource, /elements\.expectedCostLabel\.textContent = isHarvest \? "Expected material cost" : "Expected cost";/);
  assert.match(mainSource, /elements\.expectedCostHint\.textContent = isHarvest \? "candidate and requirement cost" : "including ingredient returns";/);
  assert.match(mainSource, /elements\.marketPurchaseMetric\.hidden = isHarvest;/);
  assert.match(mainSource, /elements\.unitCostMetric\.hidden = isHarvest;/);
  assert.match(mainSource, /elements\.profitMetric\.querySelector\("span"\)\.textContent = isHarvest \? "Net result" : "Sale profit";/);
  assert.match(mainSource, /state\.calculatorMode === "harvest"\s*\? "sale value minus materials"\s*:\s*"profit before fees"/);
});

test("harvest result display keeps bundle parent amounts separate from child amounts", () => {
  assert.match(mainSource, /const isBundleParent = harvestOutput\.children\.length > 0;/);
  assert.match(mainSource, /isBundleParent \? "—" : formatMoney\(harvestOutput\.marketUnitPrice\)/);
  assert.match(mainSource, /isBundleParent \? "—" : formatMoney\(harvestOutput\.revenue\)/);
  assert.match(mainSource, /formatMoney\(child\.marketUnitPrice\)/);
  assert.match(mainSource, /formatMoney\(child\.revenue\)/);
});

test("harvest result display separates chance, quantity and expected quantity", () => {
  assert.match(mainSource, /function renderHarvestChance\(output\) \{/);
  const chanceSource = mainSource.match(/function renderHarvestChance\(output\) \{[^]*?\n\}/)[0];
  const quantitySource = mainSource.match(/function renderHarvestQuantity\(output\) \{[^]*?\n\}/)[0];
  const [chance, quantity] = new Function("formatQuantity", `${chanceSource}; ${quantitySource}; return [renderHarvestChance, renderHarvestQuantity];`)(String);
  const output = { chance: 1.1, baseChance: 1, quantity: 4, baseQuantity: 1 };
  assert.equal(chance(output), "1.1% (base 1%)");
  assert.equal(quantity(output), "4 (base 1)");
  assert.match(mainSource, /<th>CHANCE<\/th><th>QUANTITY<\/th><th>EXPECTED QUANTITY<\/th>/);
  assert.match(mainSource, /renderHarvestQuantity\(harvestOutput\)/);
  assert.match(mainSource, /renderHarvestQuantity\(child\)/);
  assert.doesNotMatch(mainSource, /baseChance === .*chance/);
});

test("harvest result table is rendered in its own result area", () => {
  assert.match(htmlSource, /class="harvest-output-list harvest-results-card" id="harvestOutputList" hidden/);
  assert.match(htmlSource, /class="result-column"/);
  assert.match(mainSource, /elements\.harvestOutputList\.hidden = false;/);
});

test("harvest result rows expose shared assumed price inputs", () => {
  assert.match(mainSource, /harvest-assumed-price-input/);
  assert.match(mainSource, /makeHarvestAssumedPriceCell\(harvestOutput\.itemId\)/);
  assert.match(mainSource, /makeHarvestAssumedPriceCell\(child\.itemId\)/);
  assert.match(mainSource, /Market buy<br>unit price/);
});

test("harvest hides only the cost per item metric", () => {
  assert.match(mainSource, /elements\.unitCostMetric\.hidden = isHarvest;/);
  assert.doesNotMatch(mainSource, /elements\.expectedCostMetric\.hidden = isHarvest;/);
});

test("material display shows Harvest broken percentages and Craft returns", () => {
  const assignment = mainSource.match(/consumptionCell\.textContent = ([\s\S]*?);/);
  assert.ok(assignment, "material return display assignment exists");
  const renderReturn = new Function("state", "ingredient", "formatQuantity", `return (${assignment[1]});`);
  for (const [mode, chance, expected] of [
    ["harvest", 0, "0%"], ["harvest", 100, "100%"], ["harvest", 200, "200%"],
    ["craft", 0, "—"], ["craft", 75, "75%"],
  ]) {
    assert.equal(renderReturn({ calculatorMode: mode }, { returnChance: chance, breakChance: chance }, String), expected);
  }
  assert.match(mainSource, /elements\.consumptionLabel\.textContent = state\.calculatorMode === "harvest" \? "BROKEN" : "Return";/);
});
