const asFiniteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function consumedFraction(ingredient) {
  return ingredient.breakChance !== undefined
    ? Math.max(0, asFiniteNumber(ingredient.breakChance)) / 100
    : 1 - asFiniteNumber(ingredient.returnChance) / 100;
}

export function effectiveReturnChance(ingredient) {
  if (ingredient?.return_chance_percent !== undefined && ingredient?.return_chance_percent !== null) {
    return clamp(asFiniteNumber(ingredient.return_chance_percent), 0, 100);
  }
  return ingredient?.return_after_craft ? 100 : 0;
}

export function normalizeOutput(result) {
  const type = result?.type === "rand" ? "rand" : "const";
  const itemId = asFiniteNumber(result?.value);

  if (type === "rand") {
    const min = Math.max(0, asFiniteNumber(result?.min));
    const max = Math.max(min, asFiniteNumber(result?.max, min));
    return {
      type,
      itemId,
      min,
      max,
      expected: (min + max) / 2,
    };
  }

  const count = Math.max(0, asFiniteNumber(result?.count, 1));
  return { type, itemId, min: count, max: count, expected: count };
}

function normalizeIngredient(ingredient) {
  return {
    itemId: asFiniteNumber(ingredient?.item_id),
    quantity: Math.max(0, asFiniteNumber(ingredient?.quantity)),
    returnChance: effectiveReturnChance(ingredient),
  };
}

function recipeSignature(ingredients, outputs) {
  return JSON.stringify({
    ingredients: [...ingredients].sort((a, b) => a.itemId - b.itemId),
    outputs: [...outputs].sort((a, b) => a.itemId - b.itemId),
  });
}

export function createItemIndex(items = []) {
  return new Map(
    items
      .filter((item) => Number.isFinite(Number(item?.type_id)))
      .map((item) => [Number(item.type_id), item]),
  );
}

function parseBundle(bundle) {
  if (typeof bundle !== "string") return [];
  return bundle.split(";").map((entry) => {
    const [itemId, quantity] = entry.trim().split("x").map(Number);
    return { itemId, quantity };
  }).filter((entry) => Number.isFinite(entry.itemId) && entry.itemId > 0
    && Number.isFinite(entry.quantity) && entry.quantity > 0);
}

function expandBundle(itemId, quantity, itemIndex, path = new Set(), probability = 1) {
  const item = itemIndex?.get(Number(itemId));
  if (!item?.bundle || path.has(Number(itemId))) return [];
  const nextPath = new Set(path).add(Number(itemId));
  const entries = parseBundle(item.bundle);
  const totalWeight = entries.reduce((sum, child) => sum + child.quantity, 0);
  return entries.flatMap((child) => {
    // Rollers choose one entry; ordinary bundles grant every listed quantity.
    const weight = item.type === "roller" ? child.quantity / totalWeight : 1;
    const childQuantity = quantity * (item.type === "roller" ? weight : child.quantity);
    const childProbability = probability * weight;
    const nested = expandBundle(child.itemId, childQuantity, itemIndex, nextPath, childProbability);
    return nested.length
      ? nested
      : [{ itemId: child.itemId, quantity: childQuantity, probability: childProbability,
        parentItemId: Number(itemId) }];
  });
}

export function extractCraftCatalog(config = {}, options = {}) {
  const groupedByOutput = new Map();
  const enabledReceiptIds = new Set((options.enabledReceiptIds ?? []).map(Number));

  for (const building of config.buildings_craft ?? []) {
    for (const receipt of building.receipts ?? []) {
      if (receipt.disabled && !enabledReceiptIds.has(Number(receipt.id))) continue;

      const ingredients = (receipt.consume ?? [])
        .map(normalizeIngredient)
        .filter((ingredient) => ingredient.itemId > 0 && ingredient.quantity > 0);
      const outputs = (receipt.result ?? [])
        .map(normalizeOutput)
        .filter((output) => output.itemId > 0 && output.max > 0);

      if (!ingredients.length || !outputs.length) continue;

      const signature = recipeSignature(ingredients, outputs);
      for (const selectedOutput of outputs) {
        if (!groupedByOutput.has(selectedOutput.itemId)) {
          groupedByOutput.set(selectedOutput.itemId, new Map());
        }

        const recipes = groupedByOutput.get(selectedOutput.itemId);
        const duplicate = recipes.get(signature);
        if (duplicate) {
          if (!duplicate.sourceBuildingIds.includes(Number(building.id))) {
            duplicate.sourceBuildingIds.push(Number(building.id));
          }
          continue;
        }

        recipes.set(signature, {
          key: `${selectedOutput.itemId}:${building.id}:${receipt.id}`,
          outputItemId: selectedOutput.itemId,
          selectedOutput,
          outputs,
          ingredients,
          recipeId: Number(receipt.id),
          recipeName: receipt.name || `recipe_${receipt.id}`,
          iconUrl: receipt.icon || "",
          sourceBuildingIds: [Number(building.id)],
        });
      }
    }
  }

  return new Map(
    [...groupedByOutput.entries()].map(([itemId, recipes]) => [itemId, [...recipes.values()]]),
  );
}

function normalizeHarvestCandidate(candidate) {
  const breakChance = candidate?.break_percent === undefined
    ? 0
    : Math.max(0, asFiniteNumber(candidate.break_percent));
  return {
    itemId: asFiniteNumber(candidate?.item_id),
    count: Math.max(0, asFiniteNumber(candidate?.count, 1)),
    breakChance,
    lootmoreCoef: Math.max(0, asFiniteNumber(candidate?.lootmore_coef ?? 1, 1)),
    speedCoef: Math.max(0, asFiniteNumber(candidate?.speed_coef ?? 1, 1)),
    requirements: (candidate?.requirements ?? [])
      .map((requirement) => ({
        itemId: asFiniteNumber(requirement?.item_id),
        quantity: Math.max(0, asFiniteNumber(requirement?.count)),
      }))
      .filter((requirement) => requirement.itemId > 0 && requirement.quantity > 0),
  };
}

function harvestRewardPerks(config, receipt) {
  const buildings = (config.buildings ?? []).filter((building) => (
    building.building_type === "harvest"
    && [building.child_type_id, ...(building.upgrades ?? []).map((upgrade) => upgrade.child_type_id)]
      .some((id) => Number(id) === Number(receipt.receipt_id))
  ));
  return (config.technology_tree?.nodes ?? []).filter((perk) => !perk.disabled).map((perk) => ({
    id: Number(perk.id),
    name: perk.name,
    effects: (perk.effects ?? []).filter((effect) => {
      const bonus = effect.Effect?.HarvestResultMult;
      const addition = effect.Effect?.HarvestAddResult;
      if (Number(effect.scope) !== 1) return false;
      if (addition) {
        if (!(Number(addition.item_id) > 0) || !(Number(addition.count) > 0)
          || !Number.isFinite(Number(addition.count)) || !Number.isFinite(Number(addition.chance))
          || Number(addition.chance) < 0) return false;
      } else if (!bonus || !Number.isFinite(Number(bonus.multiplier))
        || Number(bonus.multiplier) < 0
        || !(receipt.result ?? []).some((result) => Number(result.item_id) === Number(bonus.result_item_id))) return false;
      const target = effect.Target;
      return buildings.some((building) => {
        if (target?.BuildingTarget) {
          const rule = target.BuildingTarget;
          return Number(rule.building_type_id) === Number(building.id)
            && (rule.receipt_id == null || Number(rule.receipt_id) === Number(receipt.receipt_id));
        }
        const tags = target?.TagTarget;
        if (!tags?.tags?.length) return false;
        if (Number(tags.match) === 2) return tags.tags.some((tag) => (building.tags ?? []).includes(tag));
        if (Number(tags.match) === 1) return tags.tags.every((tag) => (building.tags ?? []).includes(tag));
        return false;
      });
    }).map((effect, index) => effect.Effect.HarvestAddResult ? {
      kind: "add",
      key: `${receipt.receipt_id}:perk:${perk.id}:${index}`,
      itemId: Number(effect.Effect.HarvestAddResult.item_id),
      count: Number(effect.Effect.HarvestAddResult.count),
      chance: Number(effect.Effect.HarvestAddResult.chance),
      selectable: false,
    } : ({
      kind: "multiply",
      itemId: Number(effect.Effect.HarvestResultMult.result_item_id),
      multiplier: Number(effect.Effect.HarvestResultMult.multiplier),
    })),
  })).filter((perk) => Number.isFinite(perk.id) && perk.effects.length);
}

function harvestShards(config, receipt) {
  const rule = receipt.shards;
  if (!(Number(rule?.slots) > 0)) return [];
  const allowed = rule.allowed_tags ?? [];
  return (config.shards ?? []).filter((shard) => {
    if (shard.disabled || !(Number(shard.item_id) > 0)
      || !(Number(shard.duration_sec) > 0) || !Number.isFinite(Number(shard.duration_sec))) return false;
    if (!allowed.length) return false;
    if (rule.tag_match === "all") return allowed.every((tag) => (shard.tags ?? []).includes(tag));
    return rule.tag_match === "any" && allowed.some((tag) => (shard.tags ?? []).includes(tag));
  }).map((shard) => ({
    itemId: Number(shard.item_id), key: shard.key, name: shard.name,
    durationSec: Number(shard.duration_sec),
    effects: (shard.effects ?? []).filter((entry) => entry.scope === "harvest")
      .map((entry) => entry.effect).filter(Boolean),
  }));
}

function harvestParallelCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

export function extractHarvestCatalog(config = {}) {
  return (config.harvests ?? [])
    .filter((receipt) => !receipt?.disabled && Number.isFinite(Number(receipt?.receipt_id)))
    .map((receipt) => ({
      key: String(receipt.receipt_id),
      receiptId: Number(receipt.receipt_id),
      maxParallel: harvestParallelCount(receipt.max_parallel),
      receipt,
      rewardPerks: harvestRewardPerks(config, receipt),
      shardSlots: Math.max(0, Math.trunc(asFiniteNumber(receipt.shards?.slots))),
      shards: harvestShards(config, receipt),
      slots: (receipt.items_slots ?? []).map((slot, index) => ({
        key: `${receipt.receipt_id}:${index}`,
        name: slot.name || `slot_${index + 1}`,
        candidates: (slot.available_items ?? [])
          .filter((candidate) => !candidate?.disabled)
          .map(normalizeHarvestCandidate)
          .filter((candidate) => candidate.itemId > 0 && candidate.count > 0),
      })),
      results: (receipt.result ?? [])
        .map((result, index) => ({
          key: `${receipt.receipt_id}:${index}`,
          itemId: asFiniteNumber(result?.item_id),
          count: Math.max(0, asFiniteNumber(result?.count)),
          chance: Math.max(0, asFiniteNumber(result?.chance_percent)),
          selectable: result?.selectable === true,
        }))
        .filter((result) => result.itemId > 0 && result.count > 0),
    }))
    .filter((receipt) => receipt.results.length);
}

export function describeHarvestReceipt(receipt, {
  itemName = (itemId) => `Item #${itemId}`,
  translate = (key) => key,
  selectedCandidates = [],
} = {}) {
  const slots = receipt.slots.map((slot, slotIndex) => {
    if (!slot.candidates.length) return `${translate(slot.name)} has no candidates`;
    const requestedIndex = Number(selectedCandidates[slotIndex]);
    const selectedIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0
      && requestedIndex < slot.candidates.length
      ? requestedIndex
      : 0;
    const candidates = slot.candidates.map((candidate, candidateIndex) => {
      const requirements = candidate.requirements.length
        ? candidate.requirements
          .map((requirement) => `${itemName(requirement.itemId)} (#${requirement.itemId}) x ${requirement.quantity}`)
          .join(", ")
        : "none";
      const selectedLabel = candidateIndex === selectedIndex ? ", selected" : "";
      return `${itemName(candidate.itemId)} (#${candidate.itemId}; break chance ${candidate.breakChance}%; requirements: ${requirements}${selectedLabel})`;
    });
    return `${translate(slot.name)} candidates: ${candidates.join("; ")}`;
  });
  const results = receipt.results
    .map((result) => `${itemName(result.itemId)} (#${result.itemId}) at ${result.chance}% chance, selectable: ${result.selectable}`)
    .join(", ");
  const slotText = slots.length ? slots.join("; ") : "no equipment slots";
  const resultText = results || "no listed results";
  return `Estimated harvest description: ${slotText}; results may include ${resultText}. This is an approximation based on the receipt data.`;
}

export function calculateHarvest(
  receipt,
  runs,
  prices,
  selectedCandidates = [],
  selectedResultIds = new Set(),
  assumedPrices = new Map(),
  itemIndex = new Map(),
  selectedPerkIds = new Set(),
  selectedShardIds = [],
) {
  const safeRuns = clamp(Math.trunc(asFiniteNumber(runs, 1)), 1, 1_000_000);
  const maxParallel = harvestParallelCount(receipt.maxParallel);
  const batchCount = Math.ceil(safeRuns / maxParallel);
  const getMarketBuyPrice = (itemId) => prices.get(Number(itemId))?.buy ?? null;
  const ingredients = [];
  const addIngredient = (itemId, quantity, consumedFraction = 1, baseQuantity = quantity,
    baseConsumedFraction = consumedFraction) => {
    if (itemId <= 0 || quantity <= 0) return;
    const expectedConsumed = quantity * consumedFraction;
    const existing = ingredients.find((ingredient) => ingredient.itemId === itemId);
    if (existing) {
      existing.quantity += quantity;
      existing.expectedConsumed += expectedConsumed;
      existing.baseQuantity += baseQuantity;
      existing.baseExpectedConsumed += baseQuantity * baseConsumedFraction;
    } else ingredients.push({ itemId, quantity, expectedConsumed, baseQuantity,
      baseExpectedConsumed: baseQuantity * baseConsumedFraction });
  };

  const selectedShards = selectedShardIds.slice(0, receipt.shardSlots ?? 0)
    .map((id, slotIndex) => {
      const shard = (receipt.shards ?? []).find((entry) => entry.itemId === Number(id));
      return shard ? { ...shard, slotIndex } : null;
    })
    .filter((shard) => shard && Number.isFinite(shard.durationSec) && shard.durationSec > 0);
  const shardEffects = selectedShards.flatMap((shard) => shard.effects);
  const shardSpeedMultiplier = Math.max(0, shardEffects
    .filter((effect) => effect.kind === "harvest_speed_mult")
    .reduce((sum, effect) => sum + Math.max(0, asFiniteNumber(effect.multiplier, 1)) - 1, 1));
  let lootmoreCoef = 1;
  let speedCoef = 1;
  receipt.slots.forEach((slot, slotIndex) => {
    const candidateIndex = Number(selectedCandidates[slotIndex]);
    const candidate = slot.candidates[candidateIndex] ?? slot.candidates[0];
    if (!candidate) return;
    lootmoreCoef += (candidate.lootmoreCoef ?? 1) - 1;
    speedCoef += (candidate.speedCoef ?? 1) - 1;
    const effects = shardEffects.filter((effect) => !effect.tool_item_ids?.length
      || effect.tool_item_ids.map(Number).includes(candidate.itemId));
    const delta = effects.filter((effect) => effect.kind === "harvest_break_chance_delta")
      .reduce((sum, effect) => sum + asFiniteNumber(effect.delta_percent_points), 0);
    const breakMultiplier = Math.max(0, effects
      .filter((effect) => effect.kind === "harvest_break_chance_mult")
      .reduce((sum, effect) => sum + Math.max(0, asFiniteNumber(effect.multiplier, 1)) - 1, 1));
    const breakChance = Math.max(0, (candidate.breakChance + delta)
      * breakMultiplier);
    addIngredient(candidate.itemId, candidate.count * safeRuns, breakChance / 100,
      candidate.count * safeRuns, candidate.breakChance / 100);
    candidate.requirements.forEach((requirement) => {
      addIngredient(requirement.itemId, requirement.quantity * safeRuns);
    });
  });
  const baseDurationSec = Math.max(0, asFiniteNumber(receipt.receipt?.duration_sec));
  const effectiveSpeed = speedCoef * shardSpeedMultiplier;
  const durationSec = baseDurationSec > 0 && effectiveSpeed > 0
    && Number.isFinite(effectiveSpeed) ? baseDurationSec / effectiveSpeed : null;
  selectedShards.forEach((shard) => {
    if (durationSec !== null) addIngredient(shard.itemId, durationSec / shard.durationSec / maxParallel * batchCount,
      1, baseDurationSec / shard.durationSec / maxParallel * batchCount, 1);
  });
  const rewardMultiplier = Math.max(0, shardEffects
    .filter((effect) => effect.kind === "harvest_result_mult")
    .reduce((sum, effect) => sum + Math.max(0, asFiniteNumber(effect.multiplier, 1)) - 1, 1));
  lootmoreCoef = Math.max(0, lootmoreCoef) * rewardMultiplier;

  let expectedCost = 0;
  let purchaseCost = 0;
  let costComplete = !selectedShards.length || durationSec !== null;
  const calculatedIngredients = ingredients.map((ingredient) => {
    const marketUnitPrice = prices.get(ingredient.itemId)?.sell ?? null;
    const unitPrice = getEffectiveSellPrice(ingredient.itemId, prices, assumedPrices);
    const lineCost = ingredient.expectedConsumed === 0 ? 0
      : unitPrice === null ? null : ingredient.expectedConsumed * unitPrice;
    if (lineCost === null) costComplete = false;
    else expectedCost += lineCost;
    if (lineCost !== null) purchaseCost += lineCost;
    return {
      ...ingredient,
      breakChance: 100 * ingredient.expectedConsumed / ingredient.quantity,
      baseBreakChance: 100 * ingredient.baseExpectedConsumed / ingredient.baseQuantity,
      returnChance: 100 * (1 - ingredient.expectedConsumed / ingredient.quantity),
      baseReturnChance: 100 * (1 - ingredient.baseExpectedConsumed / ingredient.baseQuantity),
      marketUnitPrice,
      unitPrice,
      expectedCost: lineCost,
      purchaseCost: lineCost,
    };
  });

  const selectableResultCount = receipt.results.filter((result) => result.selectable).length;
  const checkedSelectableCount = receipt.results.filter((result, resultIndex) => {
    const key = result.key ?? `${receipt.key ?? receipt.receiptId}:${resultIndex}`;
    return result.selectable && (selectedResultIds.has(key)
      || (selectableResultCount === 1 && selectedResultIds.has(result.itemId)));
  }).length;
  const perkEffects = (receipt.rewardPerks ?? [])
    .filter((perk) => selectedPerkIds.has(perk.id)).flatMap((perk) => perk.effects);
  const shardResults = selectedShards.flatMap((shard) => shard.effects.flatMap((effect, index) => (
    effect.kind === "harvest_add_result" && Number(effect.item_id) > 0 && Number(effect.count) > 0
      && Number.isFinite(Number(effect.count)) && Number.isFinite(Number(effect.chance)) && Number(effect.chance) >= 0
      ? [{ kind: "add", key: `${receipt.receiptId}:shard:${shard.slotIndex}:${shard.itemId}:${index}`,
        itemId: Number(effect.item_id), count: Number(effect.count), chance: Number(effect.chance), selectable: false }]
      : []
  )));
  const results = [...receipt.results, ...perkEffects.filter((effect) => effect.kind === "add"), ...shardResults];
  const outputs = results.map((result, resultIndex) => {
    const key = result.key ?? `${receipt.key ?? receipt.receiptId}:${resultIndex}`;
    const selected = !result.selectable || selectedResultIds.has(key)
      || (selectableResultCount === 1 && selectedResultIds.has(result.itemId));
    const sharedChance = result.selectable
      ? checkedSelectableCount > 0 && selected ? result.chance / checkedSelectableCount : 0
      : result.chance;
    const perkMultiplier = perkEffects
      .filter((effect) => result.kind !== "add" && effect.kind !== "add" && effect.itemId === result.itemId)
      .reduce((multiplier, effect) => multiplier * effect.multiplier, 1);
    const effectiveChance = clamp(sharedChance * perkMultiplier, 0, 100);
    const quantity = result.count * Math.max(0, lootmoreCoef);
    const expected = selected ? effectiveChance / 100 * quantity * safeRuns : 0;
    const marketUnitPrice = getMarketBuyPrice(result.itemId);
    const unitPrice = getEffectiveBuyPrice(result.itemId, prices, assumedPrices);
    const children = expandBundle(result.itemId, result.count, itemIndex).map((child, childIndex) => {
      const childMarketPrice = getMarketBuyPrice(child.itemId);
      const childPrice = getEffectiveBuyPrice(child.itemId, prices, assumedPrices);
      const childExpected = effectiveChance / 100 * child.quantity * Math.max(0, lootmoreCoef) * safeRuns;
      const baseQuantity = child.probability > 0 ? child.quantity / child.probability : 0;
      return {
        type: "bundle-child",
        key: `${key}:child:${childIndex}`,
        itemId: child.itemId,
        parentItemId: child.parentItemId,
        min: childExpected,
        max: childExpected,
        baseQuantity,
        quantity: baseQuantity * Math.max(0, lootmoreCoef),
        expected: childExpected,
        chance: effectiveChance * child.probability,
        baseChance: result.chance * child.probability,
        selectable: result.selectable,
        selected,
        marketUnitPrice: childMarketPrice,
        unitPrice: childPrice,
        revenue: childExpected === 0 ? 0 : childPrice === null ? null : childExpected * childPrice,
      };
    });
    const revenue = children.length
      ? children.every((child) => child.revenue !== null)
        ? children.reduce((sum, child) => sum + child.revenue, 0)
        : null
      : expected === 0 ? 0 : unitPrice === null ? null : expected * unitPrice;
    return {
      type: "const",
      key,
      itemId: result.itemId,
      min: expected,
      max: expected,
      quantity,
      baseQuantity: result.count,
      expected,
      chance: effectiveChance,
      baseChance: result.chance,
      selectable: result.selectable,
      selected,
      marketUnitPrice,
      unitPrice,
      revenue,
      children,
    };
  });
  const selectedOutputs = outputs.flatMap((output) => output.children.length ? output.children : [output])
    .filter((output) => output.selected);
  const expectedRevenue = selectedOutputs.reduce((sum, output) => sum + (output.revenue ?? 0), 0);
  const revenueComplete = selectedOutputs.every((output) => output.revenue !== null);
  const outputQuantity = selectedOutputs.reduce((sum, output) => sum + output.expected, 0);
  const profit = costComplete && revenueComplete ? expectedRevenue - expectedCost : null;

  return {
    runs: safeRuns,
    baseDurationSec,
    durationSec,
    shardDurationComplete: !selectedShards.length || durationSec !== null,
    ingredients: calculatedIngredients,
    outputs,
    selectedOutput: selectedOutputs[0] ?? null,
    expectedCost: costComplete ? expectedCost : null,
    coveredExpectedCost: expectedCost,
    purchaseCost: costComplete ? purchaseCost : null,
    coveredPurchaseCost: purchaseCost,
    expectedRevenue: revenueComplete ? expectedRevenue : null,
    coveredExpectedRevenue: expectedRevenue,
    unitCost: outputQuantity > 0 && costComplete ? expectedCost / outputQuantity : null,
    profit,
    costComplete,
    purchaseComplete: costComplete,
    revenueComplete,
    readyItemUnitPrice: null,
    readyItemPurchaseCost: null,
    savingsVsBuying: null,
    root: {
      kind: "harvest",
      receiptId: receipt.receiptId,
      quantity: outputQuantity,
      children: outputs,
    },
  };
}

export function createPriceIndex(market) {
  const nullablePrice = (value) => value === undefined || value === null || value === ""
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  return new Map(
    (market?.items ?? [])
      .map((item) => ({
        itemId: Number(item.item_type_id),
        buy: nullablePrice(item.best_buy_price),
        sell: nullablePrice(item.best_sell_price),
      }))
      .filter((item) => Number.isFinite(item.itemId) && item.itemId > 0)
      .map((item) => [item.itemId, { buy: item.buy, sell: item.sell }]),
  );
}

export function getEffectiveBuyPrice(itemId, prices, assumedPrices = new Map()) {
  const itemKey = Number(itemId);
  const assumed = assumedPrices.get(itemKey);
  if (assumed !== undefined && assumed !== null && Number.isFinite(Number(assumed))) {
    return Number(assumed);
  }
  return prices.get(itemKey)?.buy ?? null;
}

export function getEffectiveSellPrice(itemId, prices, assumedPrices = new Map()) {
  const itemKey = Number(itemId);
  const assumed = assumedPrices.get(itemKey);
  if (assumed !== undefined && assumed !== null && Number.isFinite(Number(assumed))) {
    return Number(assumed);
  }
  return prices.get(itemKey)?.sell ?? null;
}

export function calculateRecipe(recipe, runs, prices, assumedPrices = new Map()) {
  const safeRuns = clamp(Math.trunc(asFiniteNumber(runs, 1)), 1, 1_000_000);
  let expectedCost = 0;
  let purchaseCost = 0;
  let expectedRevenue = 0;
  let costComplete = true;
  let purchaseComplete = true;
  let revenueComplete = true;

  const ingredients = recipe.ingredients.map((ingredient) => {
    const quantity = ingredient.quantity * safeRuns;
    const expectedConsumed = quantity * consumedFraction(ingredient);
    const marketUnitPrice = prices.get(ingredient.itemId)?.sell ?? null;
    const unitPrice = getEffectiveSellPrice(ingredient.itemId, prices, assumedPrices);
    const linePurchaseCost = unitPrice === null ? null : quantity * unitPrice;
    const lineExpectedCost = unitPrice === null ? null : expectedConsumed * unitPrice;

    if (lineExpectedCost === null) costComplete = false;
    else expectedCost += lineExpectedCost;
    if (linePurchaseCost === null) purchaseComplete = false;
    else purchaseCost += linePurchaseCost;

    return {
      ...ingredient,
      quantity,
      expectedConsumed,
      marketUnitPrice,
      unitPrice,
      purchaseCost: linePurchaseCost,
      expectedCost: lineExpectedCost,
    };
  });

  const outputs = recipe.outputs.map((output) => {
    const min = output.min * safeRuns;
    const max = output.max * safeRuns;
    const expected = output.expected * safeRuns;
    const unitPrice = prices.get(output.itemId)?.buy ?? null;
    const revenue = unitPrice === null ? null : expected * unitPrice;

    if (revenue === null) revenueComplete = false;
    else expectedRevenue += revenue;

    return { ...output, min, max, expected, unitPrice, revenue };
  });

  const selectedOutput = outputs.find((output) => output.itemId === recipe.outputItemId);
  const readyItemUnitPrice = prices.get(recipe.outputItemId)?.sell ?? null;
  const readyItemPurchaseCost = readyItemUnitPrice === null || !selectedOutput
    ? null
    : selectedOutput.expected * readyItemUnitPrice;
  const unitCost = costComplete && selectedOutput?.expected > 0
    ? expectedCost / selectedOutput.expected
    : null;
  const profit = costComplete && revenueComplete ? expectedRevenue - expectedCost : null;
  const savingsVsBuying = costComplete && readyItemPurchaseCost !== null
    ? readyItemPurchaseCost - expectedCost
    : null;

  return {
    runs: safeRuns,
    ingredients,
    outputs,
    selectedOutput,
    expectedCost: costComplete ? expectedCost : null,
    coveredExpectedCost: expectedCost,
    purchaseCost: purchaseComplete ? purchaseCost : null,
    coveredPurchaseCost: purchaseCost,
    expectedRevenue: revenueComplete ? expectedRevenue : null,
    coveredExpectedRevenue: expectedRevenue,
    readyItemUnitPrice,
    readyItemPurchaseCost,
    savingsVsBuying,
    unitCost,
    profit,
    costComplete,
    purchaseComplete,
    revenueComplete,
  };
}

export function calculateCraftChain(recipe, runs, prices, catalog, options = {}, assumedPrices = new Map()) {
  const maxDepth = Math.max(1, Math.trunc(asFiniteNumber(options.maxDepth, 12)));
  const direct = calculateRecipe(recipe, runs, prices, assumedPrices);

  function marketNode(itemId, quantity, reason = "raw") {
    const marketUnitPrice = prices.get(itemId)?.sell ?? null;
    const unitPrice = getEffectiveSellPrice(itemId, prices, assumedPrices);
    const cost = unitPrice === null ? null : quantity * unitPrice;
    return {
      kind: "market",
      itemId,
      quantity,
      marketUnitPrice,
      unitPrice,
      cost,
      coveredCost: cost ?? 0,
      complete: cost !== null,
      missingItemIds: cost === null ? [itemId] : [],
      reason,
      children: [],
    };
  }

  function craftNode(targetRecipe, craftRuns, path, depth) {
    const selectedOutput = targetRecipe.selectedOutput;
    const quantity = selectedOutput.expected * craftRuns;
    const marketUnitPrice = prices.get(targetRecipe.outputItemId)?.sell ?? null;
    const marketPurchaseCost = marketUnitPrice === null ? null : quantity * marketUnitPrice;
    const children = targetRecipe.ingredients
      .map((ingredient) => {
        const quantity = ingredient.quantity * craftRuns * consumedFraction(ingredient);
        if (quantity <= 0) return null;
        return expandItem(ingredient.itemId, quantity, path, depth + 1);
      })
      .filter(Boolean);

    const complete = children.every((child) => child.complete);
    const coveredCost = children.reduce((sum, child) => sum + child.coveredCost, 0);
    const missingItemIds = [...new Set(children.flatMap((child) => child.missingItemIds))];

    return {
      kind: "craft",
      itemId: targetRecipe.outputItemId,
      quantity,
      craftRuns,
      recipe: targetRecipe,
      marketUnitPrice,
      marketPurchaseCost,
      cost: complete ? coveredCost : null,
      coveredCost,
      complete,
      missingItemIds,
      children,
    };
  }

  function expandItem(itemId, quantity, path, depth) {
    if (depth >= maxDepth) return marketNode(itemId, quantity, "depth_limit");
    if (path.includes(itemId)) return marketNode(itemId, quantity, "cycle");

    const recipes = catalog.get(itemId) ?? [];
    if (!recipes.length) return marketNode(itemId, quantity);

    const candidates = recipes
      .filter((candidate) => candidate.selectedOutput.expected > 0)
      .map((candidate) => {
        const craftRuns = quantity / candidate.selectedOutput.expected;
        return craftNode(candidate, craftRuns, [...path, itemId], depth);
      });
    const completeCandidates = candidates
      .filter((candidate) => candidate.complete)
      .sort((a, b) => a.cost - b.cost);

    if (completeCandidates.length) return completeCandidates[0];

    const marketFallback = marketNode(itemId, quantity, "recipe_incomplete");
    if (marketFallback.complete) return marketFallback;

    if (!candidates.length) return marketFallback;
    return candidates.sort((a, b) => (
      a.missingItemIds.length - b.missingItemIds.length
      || b.coveredCost - a.coveredCost
    ))[0];
  }

  const root = craftNode(recipe, direct.runs, [recipe.outputItemId], 0);
  const rawByItem = new Map();
  let craftSteps = 0;

  function collect(node) {
    if (node.kind === "craft") {
      craftSteps += 1;
      node.children.forEach(collect);
      return;
    }

    const current = rawByItem.get(node.itemId) ?? {
      itemId: node.itemId,
      quantity: 0,
      marketUnitPrice: node.marketUnitPrice,
      unitPrice: node.unitPrice,
      cost: node.unitPrice === null ? null : 0,
      missing: node.unitPrice === null,
    };
    current.quantity += node.quantity;
    if (current.cost !== null && node.cost !== null) current.cost += node.cost;
    else current.cost = null;
    current.marketUnitPrice = current.marketUnitPrice ?? node.marketUnitPrice;
    current.unitPrice = current.unitPrice ?? node.unitPrice;
    current.missing ||= node.unitPrice === null;
    rawByItem.set(node.itemId, current);
  }

  collect(root);
  const rawMaterials = [...rawByItem.values()].sort((a, b) => a.itemId - b.itemId);
  const expectedCost = root.complete ? root.coveredCost : null;
  const unitCost = expectedCost !== null && direct.selectedOutput?.expected > 0
    ? expectedCost / direct.selectedOutput.expected
    : null;
  const profit = expectedCost !== null && direct.expectedRevenue !== null
    ? direct.expectedRevenue - expectedCost
    : null;
  const savingsVsBuying = expectedCost !== null && direct.readyItemPurchaseCost !== null
    ? direct.readyItemPurchaseCost - expectedCost
    : null;

  return {
    ...direct,
    expectedCost,
    coveredExpectedCost: root.coveredCost,
    purchaseCost: expectedCost,
    coveredPurchaseCost: root.coveredCost,
    unitCost,
    profit,
    savingsVsBuying,
    costComplete: root.complete,
    purchaseComplete: root.complete,
    root,
    rawMaterials,
    craftSteps,
  };
}
