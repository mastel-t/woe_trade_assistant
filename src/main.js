import "./styles.css";
import {
  calculateCraftChain,
  calculateHarvest,
  calculateRecipe,
  createItemIndex,
  createPriceIndex,
  extractHarvestCatalog,
  extractCraftCatalog,
} from "./calculator.js";

const DEFAULT_API_BASE = "https://woe-idle.com/api/public/v1";
const queryApi = new URLSearchParams(window.location.search).get("api");
const API_BASE = (queryApi || import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");

const state = {
  config: null,
  marketplace: null,
  translations: {},
  items: new Map(),
  catalog: new Map(),
  harvestCatalog: [],
  prices: new Map(),
  perkIds: new Set(),
  selectedMarket: null,
  visibleItemIds: [],
  assumedPrices: new Map(),
  costMode: "direct",
  calculatorMode: "craft",
  selectedHarvestCandidates: [],
  selectedHarvestResults: new Set(),
  harvestSelections: new Map(),
};

const elements = Object.fromEntries(
  [
    "calculator", "loadingPanel", "results", "errorPanel", "errorMessage",
    "errorRetryButton", "refreshButton", "liveBadge", "liveLabel", "citySelect",
    "itemSearch", "itemSelect", "recipeField", "recipeSelect",
    "runsInput", "decreaseRuns", "increaseRuns", "perkList", "selectedItemImage", "itemTierBadge",
    "selectedItemName", "selectedRecipeName", "outputAmount", "expectedCost", "unitCost",
    "calculatorTitle", "runsLabel", "resultLabel",
    "harvestOutputList", "harvestReceiptSummary",
    "expectedCostMetric", "expectedCostLabel", "expectedCostHint", "unitCostMetric", "unitCostLabel",
    "unitCostHint", "instantRevenueMetric", "instantRevenueLabel", "instantRevenueHint", "instantRevenue",
    "marketPurchaseMetric", "marketPurchaseLabel", "marketPurchaseHint", "marketPurchaseCost", "profitMetric", "expectedProfit",
    "profitHint", "savingsMetric", "craftSavings", "savingsHint",
    "costFootnote", "purchaseTotal", "purchaseLabel", "ingredientsTitle", "ingredientsBody",
    "missingPriceNote", "coProducts", "directModeButton", "chainModeButton", "chainTree",
    "chainSteps", "chainTreeBody", "chainTreeTitle",
    "craftModeButton", "harvestModeButton", "harvestOptions",
  ].map((id) => [id, document.getElementById(id)]),
);

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const quantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const smallQuantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "short",
});

function deepGet(object, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function humanizeKey(key) {
  if (!key) return "Untitled";
  const leaf = String(key).includes(".") ? String(key).split(".").at(-2) || key : key;
  return leaf
    .replace(/^(item|craft_craft|craft|building)_/, "")
    .replace(/_(name|title|description)$/, "")
    .replaceAll("_", " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function translate(key) {
  const translated = deepGet(state.translations, key);
  return typeof translated === "string" ? translated : humanizeKey(key);
}

function itemName(itemId) {
  const item = state.items.get(Number(itemId));
  return item ? translate(item.name) : `Item #${itemId}`;
}

function formatMoney(value) {
  return value === null || !Number.isFinite(value) ? "—" : `${moneyFormatter.format(value)} ◈`;
}

function formatQuantity(value) {
  return Math.abs(value) > 0 && Math.abs(value) < 0.01
    ? smallQuantityFormatter.format(value)
    : quantityFormatter.format(value);
}

function setOption(select, value, label) {
  const option = document.createElement("option");
  option.value = String(value);
  option.textContent = label;
  select.append(option);
}

function marketById(id) {
  return state.marketplace?.markets?.find((market) => market.city.uuid === id) ?? null;
}

function recipeByKey(key) {
  const itemId = Number(elements.itemSelect.value);
  return state.catalog.get(itemId)?.find((recipe) => recipe.key === key) ?? null;
}

function selectedHarvest() {
  return state.harvestCatalog.find((receipt) => receipt.key === elements.itemSelect.value) ?? null;
}

function selectedRecipe() {
  return recipeByKey(elements.recipeSelect.value);
}

function setLoading(loading) {
  elements.calculator.setAttribute("aria-busy", String(loading));
  elements.loadingPanel.hidden = !loading;
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle("is-loading", loading);
  elements.liveBadge.classList.toggle("is-loading", loading);
  elements.liveLabel.textContent = loading ? "Refreshing…" : "Data is up to date";
}

function showError(error) {
  elements.errorMessage.textContent = error instanceof Error ? error.message : String(error);
  elements.errorPanel.hidden = false;
  elements.results.hidden = true;
  elements.liveBadge.classList.add("has-error");
  elements.liveLabel.textContent = "No data";
}

async function fetchJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${label}: server returned ${response.status}`);
  return response.json();
}

async function loadData() {
  setLoading(true);
  elements.errorPanel.hidden = true;
  elements.liveBadge.classList.remove("has-error");

  try {
    const [config, marketplace] = await Promise.all([
      fetchJson(`${API_BASE}/configs`, "Configuration"),
      fetchJson(`${API_BASE}/marketplace/items`, "Marketplace"),
    ]);

    if (!Array.isArray(config.items) || !Array.isArray(config.buildings_craft)) {
      throw new Error("The configuration API returned an unknown data format");
    }
    if (!Array.isArray(marketplace.markets) || marketplace.markets.length === 0) {
      throw new Error("The marketplace response contains no cities");
    }

    state.config = config;
    state.marketplace = marketplace;
    state.items = createItemIndex(config.items);

    elements.liveBadge.title = `Configuration ${config.version || "unversioned"} · prices as of ${dateFormatter.format(new Date(marketplace.server_now_unix_ms))}`;
    populatePerks();
    state.harvestCatalog = extractHarvestCatalog(config);
    rebuildCatalog();
    populateCities();
    selectMarket(elements.citySelect.value);
    enableControls();
    elements.results.hidden = false;
    renderCalculation();
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

function populateCities() {
  const previous = elements.citySelect.value;
  elements.citySelect.replaceChildren();
  for (const market of state.marketplace.markets) {
    setOption(elements.citySelect, market.city.uuid, translate(market.city.name));
  }
  if (marketById(previous)) elements.citySelect.value = previous;
}

function enableControls() {
  for (const element of [elements.citySelect, elements.itemSearch, elements.itemSelect, elements.runsInput]) {
    element.disabled = false;
  }
}

function recipeUnlockPerks() {
  return (state.config?.technology_tree?.nodes ?? []).filter((perk) => (
    (perk.effects ?? []).some((effect) => Number.isFinite(Number(
      effect.Target?.BuildingTarget?.receipt_id,
    )) && effect.Effect?.CraftEnableReceipt !== undefined)
  ));
}

function enabledReceiptIds() {
  return recipeUnlockPerks()
    .filter((perk) => state.perkIds.has(Number(perk.id)))
    .flatMap((perk) => (perk.effects ?? [])
      .filter((effect) => effect.Effect?.CraftEnableReceipt !== undefined)
      .map((effect) => Number(effect.Target?.BuildingTarget?.receipt_id)))
    .filter(Number.isFinite);
}

function populatePerks() {
  const availablePerkIds = new Set(recipeUnlockPerks().map((perk) => Number(perk.id)));
  state.perkIds = new Set([...state.perkIds].filter((perkId) => availablePerkIds.has(perkId)));
  elements.perkList.replaceChildren();
  for (const perk of recipeUnlockPerks()) {
    const label = document.createElement("label");
    label.className = "perk-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(perk.id);
    checkbox.checked = state.perkIds.has(Number(perk.id));
    checkbox.addEventListener("change", () => {
      const perkId = Number(checkbox.value);
      if (checkbox.checked) state.perkIds.add(perkId);
      else state.perkIds.delete(perkId);
      rebuildCatalog();
    });
    const name = document.createElement("span");
    name.textContent = translate(perk.name);
    label.append(checkbox, name);
    elements.perkList.append(label);
  }
}

function rebuildCatalog() {
  const previousItemId = Number(elements.itemSelect.value);
  state.catalog = extractCraftCatalog(state.config, { enabledReceiptIds: enabledReceiptIds() });
  if (state.calculatorMode === "craft") {
    populateItems(elements.itemSearch.value, state.catalog.has(previousItemId) ? previousItemId : null);
  } else {
    populateItems(elements.itemSearch.value, state.harvestCatalog.some((receipt) => receipt.key === elements.itemSelect.value) ? elements.itemSelect.value : null);
  }
}

function selectMarket(marketId) {
  const previousItemId = Number(elements.itemSelect.value);
  const previousReceiptKey = elements.itemSelect.value;
  state.selectedMarket = marketById(marketId) ?? state.marketplace.markets[0];
  elements.citySelect.value = state.selectedMarket.city.uuid;
  state.prices = createPriceIndex(state.selectedMarket);
  populateItems(
    elements.itemSearch.value,
    state.calculatorMode === "harvest"
      ? previousReceiptKey
      : state.catalog.has(previousItemId) ? previousItemId : null,
  );
}

function availableItemIds() {
  return [...state.catalog.keys()].filter((itemId) => state.items.has(itemId));
}

function bestInitialItemId() {
  const candidates = availableItemIds()
    .map((itemId) => {
      const completeRecipes = (state.catalog.get(itemId) ?? []).filter((recipe) => {
        const calculation = calculateRecipe(recipe, 1, state.prices);
        return calculation.costComplete && calculation.revenueComplete;
      });
      return {
        itemId,
        label: itemName(itemId),
        ingredientCount: Math.min(...completeRecipes.map((recipe) => recipe.ingredients.length)),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.ingredientCount))
    .sort((a, b) => a.ingredientCount - b.ingredientCount || a.label.localeCompare(b.label, "en"));

  return candidates[0]?.itemId ?? availableItemIds()[0] ?? null;
}

function populateItems(search = "", preferredItemId = null) {
  if (state.calculatorMode === "harvest") {
    populateHarvestReceipts(search, preferredItemId);
    return;
  }
  const needle = search.trim().toLocaleLowerCase("en");
  const matching = availableItemIds()
    .map((itemId) => ({ itemId, label: itemName(itemId) }))
    .filter(({ itemId, label }) => !needle || label.toLocaleLowerCase("en").includes(needle) || String(itemId).includes(needle))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));

  state.visibleItemIds = matching.map(({ itemId }) => itemId);
  elements.itemSelect.replaceChildren();
  if (!matching.length) {
    setOption(elements.itemSelect, "", "No items found");
    elements.itemSelect.disabled = true;
    elements.recipeSelect.replaceChildren();
    setOption(elements.recipeSelect, "", "—");
    elements.recipeSelect.disabled = true;
    elements.results.hidden = true;
    return;
  }

  for (const { itemId, label } of matching) {
    const priceMarker = state.prices.has(itemId) ? "" : " · no price";
    setOption(elements.itemSelect, itemId, `${label} · #${itemId}${priceMarker}`);
  }
  elements.itemSelect.disabled = false;
  const initialItemId = search ? null : bestInitialItemId();
  const target = matching.some(({ itemId }) => itemId === preferredItemId)
    ? preferredItemId
    : matching.some(({ itemId }) => itemId === initialItemId)
      ? initialItemId
      : matching[0].itemId;
  elements.itemSelect.value = String(target);
  populateRecipes();
  elements.results.hidden = false;
}

function populateHarvestReceipts(search = "", preferredReceiptKey = null) {
  const needle = search.trim().toLocaleLowerCase("en");
  const matching = state.harvestCatalog.filter((receipt) => (
    !needle || `receipt ${receipt.receiptId}`.includes(needle) || String(receipt.receiptId).includes(needle)
  ));
  elements.itemSelect.replaceChildren();
  if (!matching.length) {
    setOption(elements.itemSelect, "", "No receipts found");
    elements.itemSelect.disabled = true;
    elements.harvestOptions.replaceChildren();
    elements.results.hidden = true;
    return;
  }
  matching.forEach((receipt) => setOption(
    elements.itemSelect,
    receipt.key,
    `Receipt #${receipt.receiptId} — ${receipt.results.map((result) => itemName(result.itemId)).join(" / ")}`,
  ));
  elements.itemSelect.disabled = false;
  elements.itemSelect.value = matching.some((receipt) => receipt.key === preferredReceiptKey)
    ? preferredReceiptKey
    : matching[0].key;
  elements.harvestReceiptSummary.hidden = true;
  populateHarvestOptions();
  elements.results.hidden = false;
  renderCalculation();
}

function populateHarvestOptions() {
  const receipt = selectedHarvest();
  elements.harvestOptions.replaceChildren();
  elements.harvestOptions.hidden = !receipt;
  if (!receipt) return;
  let selection = state.harvestSelections.get(receipt.key);
  if (!selection) {
    selection = {
      candidates: receipt.slots.map(() => 0),
      results: new Set(receipt.results.filter((result) => result.selectable).map((result) => result.key)),
    };
    state.harvestSelections.set(receipt.key, selection);
  }
  selection.candidates = receipt.slots.map((slot, index) => {
    if (!slot.candidates.length) return 0;
    return Math.min(Math.max(Number(selection.candidates[index]) || 0, 0), slot.candidates.length - 1);
  });
  state.selectedHarvestCandidates = selection.candidates;
  state.selectedHarvestResults = selection.results;
  const heading = document.createElement("span");
  heading.className = "field-label";
  heading.textContent = "Harvest equipment";
  elements.harvestOptions.append(heading);

  receipt.slots.forEach((slot, slotIndex) => {
    if (!slot.candidates.length) {
      const empty = document.createElement("span");
      empty.className = "harvest-empty";
      empty.textContent = `${translate(slot.name)}: no candidates`;
      elements.harvestOptions.append(empty);
      return;
    }
    const label = document.createElement("label");
    label.className = "harvest-option";
    const title = document.createElement("span");
    title.textContent = translate(slot.name);
    const select = document.createElement("select");
    slot.candidates.forEach((candidate, candidateIndex) => {
      setOption(select, candidateIndex, `${itemName(candidate.itemId)} · #${candidate.itemId}`);
    });
    select.value = String(state.selectedHarvestCandidates[slotIndex]);
    select.addEventListener("change", () => {
      selection.candidates[slotIndex] = Number(select.value);
      renderCalculation();
    });
    label.append(title, select);
    elements.harvestOptions.append(label);
  });

}

function populateRecipes() {
  const recipes = state.catalog.get(Number(elements.itemSelect.value)) ?? [];
  const previous = elements.recipeSelect.value;
  elements.recipeSelect.replaceChildren();

  recipes.forEach((recipe, index) => {
    const buildings = recipe.sourceBuildingIds.length > 1
      ? `${recipe.sourceBuildingIds.length} buildings`
      : `building #${recipe.sourceBuildingIds[0]}`;
    setOption(elements.recipeSelect, recipe.key, `${translate(recipe.recipeName)} · ${buildings}${recipes.length > 1 ? ` · variant ${index + 1}` : ""}`);
  });

  if (recipes.some((recipe) => recipe.key === previous)) {
    elements.recipeSelect.value = previous;
  } else {
    const completeRecipe = recipes.find((recipe) => {
      const calculation = calculateRecipe(recipe, elements.runsInput.value, state.prices);
      return calculation.costComplete && calculation.revenueComplete;
    });
    if (completeRecipe) elements.recipeSelect.value = completeRecipe.key;
  }
  elements.recipeSelect.disabled = recipes.length <= 1;
  elements.recipeField.classList.toggle("is-muted", recipes.length <= 1);
  renderCalculation();
}

function renderOutputAmount(output) {
  if (!output) return "—";
  if (output.min === output.max) return `${formatQuantity(output.expected)} items`;
  return `${formatQuantity(output.min)}–${formatQuantity(output.max)} items · ${formatQuantity(output.expected)} average`;
}

function renderHarvestChance(output) {
  return `${formatQuantity(output.chance)}% (base ${formatQuantity(output.baseChance)}%)`;
}

function renderItemHeader(recipe, calculation) {
  const item = state.items.get(recipe.outputItemId) ?? {};
  const imageUrl = item.icon_url_large || item.icon_url || recipe.iconUrl;
  elements.selectedItemImage.src = imageUrl || "";
  elements.selectedItemImage.hidden = !imageUrl;
  elements.selectedItemImage.onerror = () => { elements.selectedItemImage.hidden = true; };
  elements.selectedItemImage.alt = itemName(recipe.outputItemId);
  elements.itemTierBadge.textContent = item.tier ? `T${item.tier}` : `#${recipe.outputItemId}`;
  elements.selectedItemName.textContent = itemName(recipe.outputItemId);
  elements.selectedRecipeName.textContent = translate(recipe.recipeName);
  elements.outputAmount.textContent = renderOutputAmount(calculation.selectedOutput);
  elements.harvestOutputList.replaceChildren();
  elements.harvestOutputList.hidden = true;
}

function renderHarvestHeader(receipt, calculation) {
  const selectedOutputs = calculation.outputs.filter((output) => output.selected);
  const output = selectedOutputs[0] ?? null;
  const item = state.items.get(output?.itemId) ?? {};
  const imageUrl = item.icon_url_large || item.icon_url || "";
  elements.selectedItemImage.src = imageUrl;
  elements.selectedItemImage.hidden = !imageUrl;
  elements.selectedItemImage.alt = output ? itemName(output.itemId) : "";
  elements.itemTierBadge.textContent = output ? `#${output.itemId}` : `#${receipt.receiptId}`;
  elements.selectedItemName.textContent = `Receipt #${receipt.receiptId}`;
  elements.selectedRecipeName.textContent = "Harvest result";
  elements.outputAmount.textContent = output ? `${formatQuantity(calculation.root.quantity)} expected items` : "No selected results";
  const wrapper = document.createElement("div");
  wrapper.className = "harvest-results-table-wrap";
  const table = document.createElement("table");
  table.className = "harvest-results-table";
  table.innerHTML = "<thead><tr><th>Result item</th><th>Chance<br><span>(effective / base)</span></th><th>Expected<br>quantity</th><th>Market buy<br>unit price</th><th>Assumed price</th><th>Expected sale</th></tr></thead>";
  const body = document.createElement("tbody");
  calculation.outputs.forEach((harvestOutput) => {
    const row = document.createElement("tr");
    const isBundleParent = harvestOutput.children.length > 0;
    if (isBundleParent) row.className = "bundle-parent-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = harvestOutput.selected;
    checkbox.disabled = !harvestOutput.selectable;
    checkbox.setAttribute("aria-label", `Include ${itemName(harvestOutput.itemId)}`);
    if (harvestOutput.selectable) {
      checkbox.addEventListener("change", () => {
        const selection = state.harvestSelections.get(receipt.key);
        if (checkbox.checked) selection.results.add(harvestOutput.key);
        else selection.results.delete(harvestOutput.key);
        renderCalculation();
      });
      const itemCell = document.createElement("td");
      itemCell.append(checkbox, document.createTextNode(` ${itemName(harvestOutput.itemId)}`));
      row.append(itemCell);
    } else {
      const itemCell = document.createElement("td");
      itemCell.append(checkbox, document.createTextNode(` ${itemName(harvestOutput.itemId)}`));
      row.append(itemCell);
    }
    const assumedCell = makeHarvestAssumedPriceCell(harvestOutput.itemId);
    for (const text of [
      renderHarvestChance(harvestOutput),
      formatQuantity(harvestOutput.expected),
      isBundleParent ? "—" : formatMoney(harvestOutput.marketUnitPrice),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    row.append(isBundleParent ? document.createElement("td") : assumedCell);
    const revenueCell = document.createElement("td");
    revenueCell.textContent = isBundleParent ? "—" : formatMoney(harvestOutput.revenue);
    row.append(revenueCell);
    body.append(row);
    harvestOutput.children.forEach((child) => {
      const childRow = document.createElement("tr");
      childRow.className = "bundle-child-row";
      const childItemCell = document.createElement("td");
      childItemCell.textContent = `- ${itemName(child.itemId)}`;
      childRow.append(childItemCell);
      for (const text of [
        renderHarvestChance(child),
        formatQuantity(child.expected),
        formatMoney(child.marketUnitPrice),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        childRow.append(cell);
      }
      childRow.append(makeHarvestAssumedPriceCell(child.itemId));
      const childRevenueCell = document.createElement("td");
      childRevenueCell.textContent = formatMoney(child.revenue);
      childRow.append(childRevenueCell);
      body.append(childRow);
    });
  });
  table.append(body);
  wrapper.append(table);
  elements.harvestOutputList.replaceChildren(wrapper);
  elements.harvestOutputList.hidden = false;
}

function makeHarvestAssumedPriceCell(itemId) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "0.01";
  input.placeholder = "—";
  input.className = "assumed-price-input harvest-assumed-price-input";
  const value = state.assumedPrices.get(itemId);
  input.value = Number.isFinite(value) ? String(value) : "";
  input.addEventListener("change", () => updateAssumedPrice(itemId, input.value));
  cell.append(input);
  return cell;
}

function updateAssumedPrice(itemId, value) {
  const trimmed = value.trim();
  if (!trimmed) state.assumedPrices.delete(itemId);
  else {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric < 0) return;
    state.assumedPrices.set(itemId, numeric);
  }
  renderCalculation();
}

function renderMetrics(calculation) {
  elements.expectedCost.textContent = formatMoney(calculation.expectedCost);
  elements.unitCost.textContent = formatMoney(calculation.unitCost);
  elements.instantRevenue.textContent = formatMoney(calculation.expectedRevenue);
  elements.marketPurchaseCost.textContent = formatMoney(calculation.readyItemPurchaseCost);
  elements.purchaseTotal.textContent = formatMoney(calculation.purchaseCost);
  elements.expectedProfit.textContent = formatMoney(calculation.profit);
  elements.craftSavings.textContent = formatMoney(calculation.savingsVsBuying);

  elements.profitMetric.classList.remove("is-positive", "is-negative", "is-unknown");
  if (calculation.profit === null) {
    elements.profitMetric.classList.add("is-unknown");
    elements.profitHint.textContent = "requires all market prices";
  } else if (calculation.profit >= 0) {
    elements.profitMetric.classList.add("is-positive");
    elements.profitHint.textContent = state.calculatorMode === "harvest"
      ? "sale value minus materials"
      : "profit before fees";
  } else {
    elements.profitMetric.classList.add("is-negative");
    elements.profitHint.textContent = state.calculatorMode === "harvest"
      ? "sale value minus materials"
      : "loss before fees";
  }

  elements.savingsMetric.classList.remove("is-positive", "is-negative", "is-unknown");
  if (calculation.savingsVsBuying === null) {
    elements.savingsMetric.classList.add("is-unknown");
    elements.savingsHint.textContent = "finished item has no price";
  } else if (calculation.savingsVsBuying >= 0) {
    elements.savingsMetric.classList.add("is-positive");
    elements.savingsHint.textContent = "crafting is cheaper than buying";
  } else {
    elements.savingsMetric.classList.add("is-negative");
    elements.savingsHint.textContent = "crafting is more expensive than buying";
  }

  const selected = calculation.selectedOutput;
  elements.unitCostHint.textContent = selected?.min === selected?.max
    ? "based on actual output"
    : "based on average output";

  if (state.calculatorMode === "harvest") {
    elements.costFootnote.textContent = "NET RESULT = expected sale value minus material cost. Selectable results split their base chance evenly across checked results. Selected equipment multiplies result chances, capped at 100%; bundle children carry the sale value.";
  } else if (state.costMode === "chain") {
    elements.costFootnote.textContent = "The chain automatically expands craftable ingredients into raw materials and selects the cheapest complete recipe. Quantities use average output and expected consumption after returns.";
  } else {
    const reusableCount = calculation.ingredients.filter((item) => item.returnChance > 0).length;
    elements.costFootnote.textContent = reusableCount
      ? `Expected cost includes returns for ${reusableCount} ingredient${reusableCount === 1 ? "" : "s"}. “Required upfront” shows the full initial purchase cost.`
      : "Cost is calculated from the best sell orders: the amount required to buy every ingredient immediately on the marketplace.";
  }
}

function makeIngredientRow(ingredient) {
  const row = document.createElement("tr");
  const item = state.items.get(ingredient.itemId) ?? {};

  const itemCell = document.createElement("td");
  const itemWrap = document.createElement("div");
  itemWrap.className = "ingredient-item";
  const image = document.createElement("img");
  image.src = item.icon_url || "";
  image.alt = "";
  image.hidden = !image.src;
  image.onerror = () => { image.hidden = true; };
  const labels = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = itemName(ingredient.itemId);
  const id = document.createElement("small");
  id.textContent = `#${ingredient.itemId}`;
  labels.append(name, id);
  itemWrap.append(image, labels);
  itemCell.append(itemWrap);

  const quantityCell = document.createElement("td");
  quantityCell.textContent = formatQuantity(ingredient.quantity);
  const priceCell = document.createElement("td");
  const displayPrice = ingredient.marketUnitPrice ?? ingredient.unitPrice ?? null;
  priceCell.textContent = formatMoney(displayPrice);

  const assumedPriceCell = document.createElement("td");
  const assumedInput = document.createElement("input");
  assumedInput.type = "number";
  assumedInput.min = "0";
  assumedInput.step = "0.01";
  assumedInput.placeholder = "—";
  assumedInput.className = "assumed-price-input";
  const overrideValue = state.assumedPrices.get(ingredient.itemId);
  assumedInput.value = Number.isFinite(overrideValue) ? String(overrideValue) : "";
  assumedInput.addEventListener("change", () => {
    const value = assumedInput.value.trim();
    if (!value) {
      state.assumedPrices.delete(ingredient.itemId);
      renderCalculation();
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return;
    state.assumedPrices.set(ingredient.itemId, numeric);
    renderCalculation();
  });
  assumedPriceCell.append(assumedInput);

  const returnCell = document.createElement("td");
  returnCell.textContent = ingredient.returnChance ? `${formatQuantity(ingredient.returnChance)}%` : "—";
  const costCell = document.createElement("td");
  costCell.className = "line-cost";
  costCell.textContent = formatMoney(ingredient.expectedCost);

  if (ingredient.unitPrice === null) row.classList.add("has-missing-price");
  row.append(itemCell, quantityCell, priceCell, assumedPriceCell, returnCell, costCell);
  return row;
}

function renderIngredients(calculation) {
  const rows = state.costMode === "chain" && calculation.rawMaterials
    ? calculation.rawMaterials.map((material) => ({
        itemId: material.itemId,
        quantity: material.quantity,
        returnChance: 0,
        marketUnitPrice: material.marketUnitPrice ?? material.unitPrice,
        unitPrice: material.unitPrice,
        expectedCost: material.cost,
      }))
    : calculation.ingredients;
  elements.ingredientsBody.replaceChildren(...rows.map(makeIngredientRow));
  const missing = rows.filter((ingredient) => ingredient.unitPrice === null);
  elements.missingPriceNote.hidden = missing.length === 0;
  elements.missingPriceNote.textContent = missing.length
    ? `No active sell orders for: ${missing.map((item) => itemName(item.itemId)).join(", ")}. The total is hidden to avoid understating the cost.`
    : "";

  elements.ingredientsTitle.textContent = state.calculatorMode === "harvest"
    ? "Harvest materials"
    : state.costMode === "chain" ? "Market raw materials" : "Ingredients";
  elements.purchaseLabel.textContent = state.calculatorMode === "harvest"
    ? "Expected material cost"
    : state.costMode === "chain" ? "Raw material cost" : "Required upfront";
}

function renderCoProducts(recipe, calculation) {
  const coProducts = calculation.outputs.filter((output) => output.itemId !== recipe.outputItemId);
  elements.coProducts.hidden = coProducts.length === 0;
  elements.coProducts.replaceChildren();
  if (!coProducts.length) return;

  const title = document.createElement("strong");
  title.textContent = "Additional output";
  const list = document.createElement("span");
  list.textContent = coProducts
    .map((output) => `${itemName(output.itemId)} — ${renderOutputAmount(output)}`)
    .join("; ");
  elements.coProducts.append(title, list);
}

function makeChainNode(node, depth = 0) {
  if (node.kind === "market") {
    const leaf = document.createElement("div");
    leaf.className = "chain-leaf";
    const marker = document.createElement("span");
    marker.className = "chain-marker";
    marker.textContent = "M";
    const label = document.createElement("strong");
    label.textContent = itemName(node.itemId);
    const meta = document.createElement("span");
    meta.textContent = `${formatQuantity(node.quantity)} items · ${formatMoney(node.cost)}`;
    if (node.reason === "recipe_incomplete") meta.title = "A recipe exists, but the complete chain cannot currently be calculated";
    leaf.append(marker, label, meta);
    return leaf;
  }

  const details = document.createElement("details");
  details.className = "chain-node";
  details.open = depth === 0;
  const summary = document.createElement("summary");
  const labelWrap = document.createElement("span");
  labelWrap.className = "chain-node-label";
  const marker = document.createElement("span");
  marker.className = "chain-marker is-craft";
  marker.textContent = "C";
  const labels = document.createElement("span");
  const label = document.createElement("strong");
  label.textContent = itemName(node.itemId);
  const recipeLabel = document.createElement("small");
  recipeLabel.textContent = translate(node.recipe.recipeName);
  labels.append(label, recipeLabel);
  labelWrap.append(marker, labels);
  const meta = document.createElement("span");
  meta.className = "chain-node-meta";
  const quantity = document.createElement("span");
  quantity.textContent = `${formatQuantity(node.quantity)} items · ${formatQuantity(node.craftRuns)} crafts`;
  const comparison = document.createElement("span");
  comparison.className = "chain-cost-compare";
  comparison.textContent = `Craft ${formatMoney(node.cost)} · buy ${formatMoney(node.marketPurchaseCost)}`;
  if (node.cost !== null && node.marketPurchaseCost !== null) comparison.classList.add(node.cost <= node.marketPurchaseCost ? "is-cheaper" : "is-expensive");
  meta.append(quantity, comparison);
  summary.append(labelWrap, meta);
  const children = document.createElement("div");
  children.className = "chain-children";
  children.append(...node.children.map((child) => makeChainNode(child, depth + 1)));
  details.append(summary, children);
  return details;
}

function renderChain(calculation) {
  const isChain = state.costMode === "chain";
  elements.chainTree.hidden = !isChain;
  elements.chainTreeBody.replaceChildren();
  if (!isChain) return;
  elements.chainTreeTitle.textContent = "Crafting steps";
  elements.chainSteps.textContent = `${calculation.craftSteps} step${calculation.craftSteps === 1 ? "" : "s"}`;
  elements.chainTreeBody.append(makeChainNode(calculation.root));
}

function renderCalculation() {
  if (state.calculatorMode === "harvest") {
    const receipt = selectedHarvest();
    if (!receipt || !state.selectedMarket) return;
    const calculation = calculateHarvest(
      receipt,
      elements.runsInput.value,
      state.prices,
      state.selectedHarvestCandidates,
      state.selectedHarvestResults,
      state.assumedPrices,
      state.items,
    );
    elements.runsInput.value = String(calculation.runs);
    const chainOutputItemId = calculation.outputs.find((output) => output.selected)?.itemId ?? receipt.results[0]?.itemId;
    const chainOutput = {
      type: "const",
      itemId: chainOutputItemId,
      min: 1,
      max: 1,
      expected: 1,
    };
    const chainRecipe = {
      outputItemId: chainOutputItemId,
      ingredients: calculation.ingredients,
      outputs: [chainOutput],
      selectedOutput: chainOutput,
      recipeName: "Harvest materials",
    };
    const chainCalculation = calculateCraftChain(
      chainRecipe,
      1,
      state.prices,
      state.catalog,
      {},
      state.assumedPrices,
    );
    const displayedCalculation = state.costMode === "chain"
      ? {
          ...calculation,
          ...chainCalculation,
          expectedRevenue: calculation.expectedRevenue,
          coveredExpectedRevenue: calculation.coveredExpectedRevenue,
          revenueComplete: calculation.revenueComplete,
          profit: chainCalculation.expectedCost === null || calculation.expectedRevenue === null
            ? null
            : calculation.expectedRevenue - chainCalculation.expectedCost,
        }
      : calculation;
    renderHarvestHeader(receipt, calculation);
    renderMetrics(displayedCalculation);
    renderIngredients(displayedCalculation);
    elements.coProducts.hidden = true;
    renderChain(chainCalculation);
    return;
  }
  const recipe = selectedRecipe();
  if (!recipe || !state.selectedMarket) return;
  const calculation = state.costMode === "chain"
    ? calculateCraftChain(recipe, elements.runsInput.value, state.prices, state.catalog, {}, state.assumedPrices)
    : calculateRecipe(recipe, elements.runsInput.value, state.prices, state.assumedPrices);
  elements.runsInput.value = String(calculation.runs);
  renderItemHeader(recipe, calculation);
  renderMetrics(calculation);
  renderIngredients(calculation);
  renderCoProducts(recipe, calculation);
  renderChain(calculation);
}

function setCostMode(mode) {
  state.costMode = mode === "chain" ? "chain" : "direct";
  const isChain = state.costMode === "chain";
  elements.directModeButton.classList.toggle("is-active", !isChain);
  elements.chainModeButton.classList.toggle("is-active", isChain);
  elements.directModeButton.setAttribute("aria-pressed", String(!isChain));
  elements.chainModeButton.setAttribute("aria-pressed", String(isChain));
  renderCalculation();
}

function setCalculatorMode(mode) {
  state.calculatorMode = mode === "harvest" ? "harvest" : "craft";
  const isHarvest = state.calculatorMode === "harvest";
  elements.craftModeButton.checked = !isHarvest;
  elements.harvestModeButton.checked = isHarvest;
  elements.calculatorTitle.textContent = isHarvest ? "Harvest calculator" : "Crafting calculator";
  elements.runsLabel.textContent = isHarvest ? "Runs" : "Crafts";
  elements.resultLabel.textContent = isHarvest ? "Harvest result" : "Crafting result";
  elements.expectedCostLabel.textContent = isHarvest ? "Expected material cost" : "Expected cost";
  elements.expectedCostHint.textContent = isHarvest ? "candidate and requirement cost" : "including ingredient returns";
  elements.unitCostLabel.textContent = isHarvest ? "Cost per item" : "Per item";
  elements.instantRevenueLabel.textContent = isHarvest ? "Expected sale" : "Instant sale";
  elements.instantRevenueHint.textContent = isHarvest ? "selected outputs at the best buy order" : "at the best buy order";
  elements.marketPurchaseLabel.textContent = "Buy finished item";
  elements.marketPurchaseHint.textContent = "at the best sell order";
  elements.profitMetric.querySelector("span").textContent = isHarvest ? "Net result" : "Sale profit";
  elements.profitHint.textContent = isHarvest ? "sale value minus materials" : "before fees";
  elements.marketPurchaseMetric.hidden = isHarvest;
  elements.unitCostMetric.hidden = isHarvest;
  elements.savingsMetric.hidden = isHarvest;
  elements.chainModeButton.hidden = false;
  elements.directModeButton.hidden = false;
  elements.itemSearch.closest(".field").querySelector(".field-label").textContent = isHarvest ? "Find receipt" : "Find item";
  elements.itemSelect.closest(".field").querySelector(".field-label").textContent = isHarvest ? "Receipt" : "Item";
  elements.recipeField.hidden = isHarvest;
  elements.harvestReceiptSummary.hidden = !isHarvest;
  elements.harvestOptions.hidden = !isHarvest;
  state.selectedHarvestResults = new Set();
  state.selectedHarvestCandidates = [];
  populateItems(elements.itemSearch.value);
  renderCalculation();
}

function changeRuns(delta) {
  const value = Number(elements.runsInput.value) || 1;
  elements.runsInput.value = String(Math.min(1_000_000, Math.max(1, value + delta)));
  renderCalculation();
}

elements.citySelect.addEventListener("change", () => selectMarket(elements.citySelect.value));
elements.itemSearch.addEventListener("input", () => populateItems(
  elements.itemSearch.value,
  state.calculatorMode === "harvest" ? elements.itemSelect.value : Number(elements.itemSelect.value),
));
elements.itemSelect.addEventListener("change", () => {
  state.assumedPrices.clear();
  if (state.calculatorMode === "harvest") {
    populateHarvestOptions();
    renderCalculation();
  } else populateRecipes();
});
elements.recipeSelect.addEventListener("change", renderCalculation);
elements.runsInput.addEventListener("input", renderCalculation);
elements.runsInput.addEventListener("blur", renderCalculation);
elements.decreaseRuns.addEventListener("click", () => changeRuns(-1));
elements.increaseRuns.addEventListener("click", () => changeRuns(1));
elements.directModeButton.addEventListener("click", () => setCostMode("direct"));
elements.chainModeButton.addEventListener("click", () => setCostMode("chain"));
elements.craftModeButton.addEventListener("change", () => setCalculatorMode("craft"));
elements.harvestModeButton.addEventListener("change", () => setCalculatorMode("harvest"));
elements.refreshButton.addEventListener("click", loadData);
elements.errorRetryButton.addEventListener("click", loadData);

loadData();
