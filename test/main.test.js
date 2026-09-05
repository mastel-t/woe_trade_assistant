import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

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

test("harvest result display always shows effective and base chance", () => {
  assert.match(mainSource, /function renderHarvestChance\(output\) \{/);
  assert.match(mainSource, /return `\$\{formatQuantity\(output\.chance\)\}% \(base \$\{formatQuantity\(output\.baseChance\)\}%\)`;/);
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

test("material return display shows harvest zero percent and preserves craft dash", () => {
  const assignment = mainSource.match(/returnCell\.textContent = ([\s\S]*?);/);
  assert.ok(assignment, "material return display assignment exists");
  const renderReturn = new Function("state", "ingredient", "formatQuantity", `return (${assignment[1]});`);
  for (const [mode, chance, expected] of [
    ["harvest", 0, "0%"], ["harvest", 100, "100%"], ["harvest", 96, "96%"],
    ["craft", 0, "—"], ["craft", 75, "75%"],
  ]) {
    assert.equal(renderReturn({ calculatorMode: mode }, { returnChance: chance }, String), expected);
  }
});
