local ADDON_NAME = ...

local Exporter = CreateFrame("Frame")
Exporter.hooked = false
Exporter.panel = nil
Exporter.minimapButton = nil
Exporter.pendingRecipeScanVariants = false
Exporter.recipeScanVariantQueue = nil
Exporter.recipeScanVariantScheduled = false
Exporter.lastStatus = "Ready."

local RECIPE_SCAN_VARIANT_DELAY_SECONDS = 0.05
local VARIANT_RECIPE_TIME_BUDGET_MS = 75

local function Print(message)
    DEFAULT_CHAT_FRAME:AddMessage("|cff3cc6a2CraftPlan Exporter:|r " .. tostring(message))
    if Exporter and Exporter.SetStatus then
        Exporter:SetStatus(message)
    end
end

local function Now()
    return GetServerTime and GetServerTime() or time()
end

local function EnsureDB()
    CraftPlanExporterDB = CraftPlanExporterDB or {}
    CraftPlanExporterDB.schemaVersion = 1
    CraftPlanExporterDB.recordsByItemID = CraftPlanExporterDB.recordsByItemID or {}
    CraftPlanExporterDB.recordsByRecipeID = CraftPlanExporterDB.recordsByRecipeID or {}
    CraftPlanExporterDB.scanExports = CraftPlanExporterDB.scanExports or {}
    CraftPlanExporterDB.variantExports = CraftPlanExporterDB.variantExports or {}
    CraftPlanExporterDB.meta = CraftPlanExporterDB.meta or {}
    CraftPlanExporterDB.characters = CraftPlanExporterDB.characters or {}
    CraftPlanExporterDB.settings = CraftPlanExporterDB.settings or {}
    CraftPlanExporterDB.settings.minimapAngle = CraftPlanExporterDB.settings.minimapAngle or 225
    CraftPlanExporterDB.settings.variantMaxVariants = CraftPlanExporterDB.settings.variantMaxVariants or 5000
    CraftPlanExporterDB.settings.variantTopN = CraftPlanExporterDB.settings.variantTopN or 25
    if CraftPlanExporterDB.settings.includeOptionalVariants == nil then
        CraftPlanExporterDB.settings.includeOptionalVariants = false
    end
    if CraftPlanExporterDB.settings.includeFinishingVariants == nil then
        CraftPlanExporterDB.settings.includeFinishingVariants = false
    end
    if CraftPlanExporterDB.settings.autoVariantsOnRecipeScan == nil then
        CraftPlanExporterDB.settings.autoVariantsOnRecipeScan = true
    end
    CraftPlanExporterDB.lastExportAt = CraftPlanExporterDB.lastExportAt or 0
    return CraftPlanExporterDB
end

local function GetRegionSlug()
    local regionID = GetCurrentRegion and GetCurrentRegion() or nil
    local regionMap = {
        [1] = "us",
        [2] = "kr",
        [3] = "eu",
        [4] = "tw",
        [5] = "cn",
    }
    local portal = GetCVar and GetCVar("portal") or nil
    return regionMap[tonumber(regionID)] or (portal and string.lower(portal)) or "unknown"
end

local function SavePlayerMeta()
    local db = EnsureDB()
    local previousConcentration = db.meta and db.meta.concentration
    local playerName = UnitName and UnitName("player") or nil
    local realmName = GetRealmName and GetRealmName() or nil
    local normalizedRealmName = GetNormalizedRealmName and GetNormalizedRealmName() or realmName
    local faction = UnitFactionGroup and UnitFactionGroup("player") or nil
    local region = GetRegionSlug()
    local key = tostring(region) .. ":" .. tostring(normalizedRealmName or realmName or "unknown") .. ":" .. tostring(playerName or "unknown")
    local meta = {
        updatedAt = Now(),
        playerName = playerName,
        realmName = realmName,
        normalizedRealmName = normalizedRealmName,
        region = region,
        faction = faction,
    }

    db.meta = meta
    if previousConcentration then
        db.meta.concentration = previousConcentration
    end
    db.characters[key] = meta
    return meta
end

local function GetPlayerMetaKey()
    local playerName = UnitName and UnitName("player") or nil
    local realmName = GetRealmName and GetRealmName() or nil
    local normalizedRealmName = GetNormalizedRealmName and GetNormalizedRealmName() or realmName
    return tostring(GetRegionSlug()) .. ":" .. tostring(normalizedRealmName or realmName or "unknown") .. ":" ..
        tostring(playerName or "unknown")
end

local function EstimateConcentrationAmount(amount, lastUpdated, maxQuantity, rechargeTimePerPointMS)
    amount = tonumber(amount) or 0
    lastUpdated = tonumber(lastUpdated) or Now()
    maxQuantity = tonumber(maxQuantity) or amount
    rechargeTimePerPointMS = tonumber(rechargeTimePerPointMS) or 0
    if rechargeTimePerPointMS <= 0 then
        return math.min(maxQuantity, amount)
    end

    local elapsed = math.max(0, Now() - lastUpdated)
    local rechargeSeconds = rechargeTimePerPointMS / 1000
    if rechargeSeconds <= 0 then
        return math.min(maxQuantity, amount)
    end

    return math.min(maxQuantity, amount + (elapsed / rechargeSeconds))
end

local function GetConcentrationSnapshotPriority(snapshot)
    if not snapshot then return 0 end
    if snapshot.source == "blizzard-professions-ui" then return 40 end
    if snapshot.source == "visible-profession" then return 30 end
    if snapshot.source == "craftsim-currency-live" then return 20 end
    if snapshot.source == "craftsim-cache" then return 10 end
    return 1
end

local function ShouldReplaceConcentrationSnapshot(snapshot, current)
    if not snapshot then return false end
    if not current then return true end

    local samePlayer = snapshot.playerKey and current.playerKey and snapshot.playerKey == current.playerKey
    local sameCrafter = snapshot.crafterUID and current.crafterUID and snapshot.crafterUID == current.crafterUID
    local sameCurrency = snapshot.currencyID and current.currencyID and snapshot.currencyID == current.currencyID
    if (samePlayer or sameCrafter) and sameCurrency then
        local snapshotPriority = GetConcentrationSnapshotPriority(snapshot)
        local currentPriority = GetConcentrationSnapshotPriority(current)
        if snapshotPriority ~= currentPriority then
            return snapshotPriority > currentPriority
        end
    end

    return tonumber(snapshot.updatedAt or 0) >= tonumber(current.updatedAt or 0)
end

function Exporter:GetCurrentBlizzardProfessionInfo()
    local professionInfo = nil
    if Professions and Professions.GetProfessionInfo then
        local ok, result = pcall(Professions.GetProfessionInfo)
        if ok and type(result) == "table" then
            professionInfo = result
        end
    end

    if (not professionInfo or not professionInfo.professionID or professionInfo.professionID == 0) and
        C_TradeSkillUI and C_TradeSkillUI.GetChildProfessionInfo then
        local ok, result = pcall(C_TradeSkillUI.GetChildProfessionInfo)
        if ok and type(result) == "table" then
            professionInfo = result
        end
    end

    if (not professionInfo or not professionInfo.professionID or professionInfo.professionID == 0) and
        C_TradeSkillUI and C_TradeSkillUI.GetBaseProfessionInfo then
        local ok, result = pcall(C_TradeSkillUI.GetBaseProfessionInfo)
        if ok and type(result) == "table" then
            professionInfo = result
        end
    end

    if not professionInfo or not professionInfo.professionID or professionInfo.professionID == 0 then
        return nil
    end

    return professionInfo
end

function Exporter:SetStatus(message)
    self.lastStatus = tostring(message or "")
    if self.panel and self.panel.statusText then
        self.panel.statusText:SetText(self.lastStatus)
    end
end

local function SafeCall(method, object)
    if not method or not object then return nil end
    local ok, result = pcall(method, object)
    if ok then return result end
    return nil
end

local function SafeNumber(value, fallback)
    value = tonumber(value)
    if value == nil then return fallback or 0 end
    return value
end

local function Milliseconds()
    if debugprofilestop then return debugprofilestop() end
    if GetTime then return GetTime() * 1000 end
    return 0
end

local function IsTimeBudgetExceeded(startMs, budgetMs)
    budgetMs = tonumber(budgetMs) or 0
    if budgetMs <= 0 or not startMs then return false end
    return (Milliseconds() - startMs) >= budgetMs
end

local recipePriceInfoCaches = setmetatable({}, { __mode = "k" })

local function GetItemSnapshot(item)
    if not item then return nil end

    return {
        itemID = SafeCall(item.GetItemID, item),
        itemName = SafeCall(item.GetItemName, item),
        itemLink = SafeCall(item.GetItemLink, item),
    }
end

local function GetPriceInfo(recipeData, itemID)
    itemID = tonumber(itemID)
    if not itemID then return nil end

    local priceData = recipeData and recipeData.priceData
    if not priceData then return nil end

    local cache = recipePriceInfoCaches[priceData]
    if not cache then
        cache = {}
        recipePriceInfoCaches[priceData] = cache
    elseif cache[itemID] ~= nil then
        return cache[itemID]
    end

    local priceInfo = priceData and priceData.reagentPriceInfos and priceData.reagentPriceInfos[itemID]
    if not priceInfo then return nil end

    local result = {
        itemPrice = priceInfo.itemPrice,
        source = priceInfo.priceInfo and priceInfo.priceInfo.priceSource,
        noAHPriceFound = priceInfo.priceInfo and priceInfo.priceInfo.noAHPriceFound,
        isExpectedCost = priceInfo.priceInfo and priceInfo.priceInfo.isExpectedCost,
        isOverride = priceInfo.priceInfo and priceInfo.priceInfo.isOverride,
    }
    cache[itemID] = result
    return result
end

local function GetOptionalReagentSnapshot(recipeData, reagent)
    if not reagent then return nil end

    if reagent.IsCurrency and reagent:IsCurrency() then
        local currencyInfo = C_CurrencyInfo and C_CurrencyInfo.GetCurrencyInfo and C_CurrencyInfo.GetCurrencyInfo(reagent.currencyID)
        return {
            type = "currency",
            currencyID = reagent.currencyID,
            currencyName = currencyInfo and currencyInfo.name or reagent.name,
            qualityID = reagent.qualityID,
        }
    end

    local item = GetItemSnapshot(reagent.item)
    return {
        type = "item",
        itemID = item and item.itemID,
        itemName = item and item.itemName or reagent.name,
        itemLink = item and item.itemLink,
        qualityID = reagent.qualityID,
        price = item and item.itemID and GetPriceInfo(recipeData, item.itemID) or nil,
    }
end

local function ExtractOptionalSlot(recipeData, slot, slotIndex)
    if not slot then return nil end

    local possible = {}
    for possibleIndex, possibleReagent in ipairs(slot.possibleReagents or {}) do
        local possibleRecord = GetOptionalReagentSnapshot(recipeData, possibleReagent)
        if possibleRecord then
            possibleRecord.index = possibleIndex
            table.insert(possible, possibleRecord)
        end
    end

    return {
        index = slotIndex,
        dataSlotIndex = slot.dataSlotIndex,
        slotText = slot.slotText,
        required = not not slot.required,
        locked = not not slot.locked,
        lockedReason = slot.lockedReason,
        maxQuantity = slot.maxQuantity or 1,
        active = GetOptionalReagentSnapshot(recipeData, slot.activeReagent),
        possible = possible,
    }
end

local function ExtractReagents(recipeData)
    local reagentData = recipeData and recipeData.reagentData
    local result = {
        required = {},
        requiredSelectable = nil,
        optional = {},
        finishing = {},
    }

    if not reagentData then return result end

    for reagentIndex, reagent in ipairs(reagentData.requiredReagents or {}) do
        local reagentRecord = {
            index = reagentIndex,
            name = reagent.name,
            requiredQuantity = reagent.requiredQuantity,
            hasQuality = not not reagent.hasQuality,
            allocated = {},
            qualities = {},
        }

        for qualityID, reagentItem in ipairs(reagent.items or {}) do
            local item = GetItemSnapshot(reagentItem.item)
            local quantity = SafeNumber(reagentItem.quantity, 0)
            local qualityRecord = {
                qualityID = qualityID,
                itemID = item and item.itemID,
                itemName = item and item.itemName,
                itemLink = item and item.itemLink,
                quantity = quantity,
                price = item and item.itemID and GetPriceInfo(recipeData, item.itemID) or nil,
            }
            table.insert(reagentRecord.qualities, qualityRecord)

            if quantity > 0 then
                table.insert(reagentRecord.allocated, {
                    qualityID = qualityID,
                    itemID = qualityRecord.itemID,
                    itemName = qualityRecord.itemName,
                    itemLink = qualityRecord.itemLink,
                    quantity = quantity,
                })
            end
        end

        table.insert(result.required, reagentRecord)
    end

    result.requiredSelectable = ExtractOptionalSlot(recipeData, reagentData.requiredSelectableReagentSlot, 1)

    for slotIndex, slot in ipairs(reagentData.optionalReagentSlots or {}) do
        table.insert(result.optional, ExtractOptionalSlot(recipeData, slot, slotIndex))
    end

    for slotIndex, slot in ipairs(reagentData.finishingReagentSlots or {}) do
        table.insert(result.finishing, ExtractOptionalSlot(recipeData, slot, slotIndex))
    end

    return result
end

local function ExtractProfessionGear(recipeData)
    local gearSet = recipeData and recipeData.professionGearSet
    if not gearSet then return nil end

    local function gear(slot)
        if not slot then return nil end
        local item = GetItemSnapshot(slot.item)
        if not item or not item.itemID then return nil end
        return item
    end

    return {
        equipped = gearSet.IsEquipped and gearSet:IsEquipped() or nil,
        gear1 = gear(gearSet.gear1),
        gear2 = gear(gearSet.gear2),
        tool = gear(gearSet.tool),
    }
end

local function GetProfessionStatSnapshot(stat)
    if not stat then return nil end

    local percent = 0
    if stat.GetPercent then
        local ok, value = pcall(stat.GetPercent, stat, true)
        if ok then percent = SafeNumber(value, 0) end
    end

    local extraValue = 0
    if stat.GetExtraValue then
        local ok, value = pcall(stat.GetExtraValue, stat)
        if ok then extraValue = SafeNumber(value, 0) end
    end

    local extraValue2 = 0
    if stat.GetExtraValue then
        local ok, value = pcall(stat.GetExtraValue, stat, 2)
        if ok then extraValue2 = SafeNumber(value, 0) end
    end

    return {
        value = SafeNumber(stat.value, 0),
        percent = percent,
        extraValue = extraValue,
        extraValue2 = extraValue2,
    }
end

local function ExtractCraftingStats(recipeData)
    local stats = recipeData and recipeData.professionStats
    if not stats then return nil end

    return {
        skill = stats.skill and SafeNumber(stats.skill.value, 0) or 0,
        recipeDifficulty = stats.recipeDifficulty and SafeNumber(stats.recipeDifficulty.value, 0) or 0,
        multicraft = GetProfessionStatSnapshot(stats.multicraft),
        resourcefulness = GetProfessionStatSnapshot(stats.resourcefulness),
        ingenuity = GetProfessionStatSnapshot(stats.ingenuity),
    }
end

local function GetEffectiveConcentrationCost(recipeData)
    local rawCost = SafeNumber(recipeData and recipeData.concentrationCost, 0)
    if rawCost <= 0 then return 0, 0, 0 end

    local ingenuity = recipeData.professionStats and recipeData.professionStats.ingenuity
    local ingenuityChance = 0
    local ingenuityBonus = 0
    if ingenuity and ingenuity.GetPercent then
        local ok, value = pcall(ingenuity.GetPercent, ingenuity, true)
        if ok then ingenuityChance = SafeNumber(value, 0) end
    end
    if ingenuity and ingenuity.GetExtraValue then
        local ok, value = pcall(ingenuity.GetExtraValue, ingenuity)
        if ok then ingenuityBonus = SafeNumber(value, 0) end
    end

    local refundRate = 0.5 + ingenuityBonus
    local expectedRefund = rawCost * ingenuityChance * refundRate
    local effectiveCost = math.max(0, rawCost - expectedRefund)
    return effectiveCost, expectedRefund, refundRate
end

local function GetResultItem(recipeData)
    if not recipeData or not recipeData.resultData then return nil end
    local resultData = recipeData.resultData
    local item = recipeData.concentrating and resultData.expectedItemConcentration or resultData.expectedItem
    return GetItemSnapshot(item)
end

local function GetResultItemByQuality(recipeData, qualityID)
    if not recipeData or not recipeData.resultData or not qualityID then return nil end
    local item = recipeData.resultData.itemsByQuality and recipeData.resultData.itemsByQuality[qualityID]
    return GetItemSnapshot(item)
end

local function UpdateProfit(recipeData)
    if not recipeData then return end
    if recipeData.Update then pcall(recipeData.Update, recipeData) end
    if recipeData.GetAverageProfit then pcall(recipeData.GetAverageProfit, recipeData) end
end

local function ExtractVariantRequiredAllocation(recipeData)
    local allocation = {}
    local reagentData = recipeData and recipeData.reagentData
    if not reagentData then return allocation end

    for reagentIndex, reagent in ipairs(reagentData.requiredReagents or {}) do
        local reagentRecord = {
            index = reagentIndex,
            name = reagent.name,
            requiredQuantity = reagent.requiredQuantity,
            qualities = {},
        }

        for qualityID, reagentItem in ipairs(reagent.items or {}) do
            local quantity = SafeNumber(reagentItem.quantity, 0)
            if quantity > 0 then
                local item = GetItemSnapshot(reagentItem.item)
                table.insert(reagentRecord.qualities, {
                    qualityID = reagentItem.qualityID or qualityID,
                    itemID = item and item.itemID,
                    itemName = item and item.itemName,
                    itemLink = item and item.itemLink,
                    quantity = quantity,
                })
            end
        end

        table.insert(allocation, reagentRecord)
    end

    return allocation
end

local function ExtractVariantActiveSlots(recipeData, slots)
    local allocation = {}
    for slotIndex, slot in ipairs(slots or {}) do
        if slot.activeReagent then
            local active = GetOptionalReagentSnapshot(recipeData, slot.activeReagent)
            if active then
                active.index = slotIndex
                active.slotText = slot.slotText
                table.insert(allocation, active)
            end
        end
    end
    return allocation
end

local function ExtractVariantAllocation(recipeData)
    local reagentData = recipeData and recipeData.reagentData
    if not reagentData then return {} end

    return {
        required = ExtractVariantRequiredAllocation(recipeData),
        requiredSelectable = reagentData.requiredSelectableReagentSlot and
            ExtractVariantActiveSlots(recipeData, { reagentData.requiredSelectableReagentSlot }) or {},
        optional = ExtractVariantActiveSlots(recipeData, reagentData.optionalReagentSlots),
        finishing = ExtractVariantActiveSlots(recipeData, reagentData.finishingReagentSlots),
    }
end

local function BuildRequiredDimension(reagent, reagentIndex)
    local options = {}
    local itemCount = #(reagent.items or {})

    local function addOption(quantities)
        table.insert(options, {
            reagentIndex = reagentIndex,
            quantities = quantities,
        })
    end

    if not reagent.hasQuality or itemCount <= 1 then
        addOption({ [1] = reagent.requiredQuantity or 0 })
        return {
            kind = "required",
            key = "required:" .. tostring(reagentIndex),
            reagentIndex = reagentIndex,
            options = options,
        }
    end

    local quantities = {}
    local function recurse(qualityIndex, remaining)
        if qualityIndex == itemCount then
            quantities[qualityIndex] = remaining
            local snapshot = {}
            for index = 1, itemCount do
                snapshot[index] = quantities[index] or 0
            end
            addOption(snapshot)
            return
        end

        for quantity = 0, remaining do
            quantities[qualityIndex] = quantity
            recurse(qualityIndex + 1, remaining - quantity)
        end
    end

    recurse(1, reagent.requiredQuantity or 0)

    return {
        kind = "required",
        key = "required:" .. tostring(reagentIndex),
        reagentIndex = reagentIndex,
        options = options,
    }
end

local function BuildSlotOption(recipeData, reagent, clear)
    if clear then
        return {
            clear = true,
            label = "none",
        }
    end

    local snapshot = GetOptionalReagentSnapshot(recipeData, reagent)
    if not snapshot then return nil end

    return {
        clear = false,
        asCurrency = snapshot.type == "currency",
        itemID = snapshot.itemID,
        itemName = snapshot.itemName,
        itemLink = snapshot.itemLink,
        currencyID = snapshot.currencyID,
        currencyName = snapshot.currencyName,
        qualityID = snapshot.qualityID,
        label = snapshot.itemName or snapshot.currencyName or snapshot.itemID or snapshot.currencyID,
    }
end

local function BuildSlotDimension(recipeData, slot, group, slotIndex)
    if not slot or slot.locked then return nil end

    local options = {}
    if not slot.required then
        table.insert(options, BuildSlotOption(recipeData, nil, true))
    end

    for _, possibleReagent in ipairs(slot.possibleReagents or {}) do
        local option = BuildSlotOption(recipeData, possibleReagent, false)
        if option then table.insert(options, option) end
    end

    if #options <= 1 then return nil end

    return {
        kind = "slot",
        key = group .. ":" .. tostring(slotIndex),
        group = group,
        slotIndex = slotIndex,
        options = options,
    }
end

local function BuildVariantDimensions(recipeData, options)
    local reagentData = recipeData and recipeData.reagentData
    local dimensions = {}
    local totalEstimated = 1
    if not reagentData then return dimensions, totalEstimated end

    for reagentIndex, reagent in ipairs(reagentData.requiredReagents or {}) do
        local dimension = BuildRequiredDimension(reagent, reagentIndex)
        table.insert(dimensions, dimension)
        totalEstimated = totalEstimated * math.max(1, #dimension.options)
    end

    if options.includeOptional then
        local requiredSelectable = BuildSlotDimension(recipeData, reagentData.requiredSelectableReagentSlot,
            "requiredSelectable", 1)
        if requiredSelectable then
            table.insert(dimensions, requiredSelectable)
            totalEstimated = totalEstimated * math.max(1, #requiredSelectable.options)
        end

        for slotIndex, slot in ipairs(reagentData.optionalReagentSlots or {}) do
            local dimension = BuildSlotDimension(recipeData, slot, "optional", slotIndex)
            if dimension then
                table.insert(dimensions, dimension)
                totalEstimated = totalEstimated * math.max(1, #dimension.options)
            end
        end
    end

    if options.includeFinishing then
        for slotIndex, slot in ipairs(reagentData.finishingReagentSlots or {}) do
            local dimension = BuildSlotDimension(recipeData, slot, "finishing", slotIndex)
            if dimension then
                table.insert(dimensions, dimension)
                totalEstimated = totalEstimated * math.max(1, #dimension.options)
            end
        end
    end

    return dimensions, totalEstimated
end

local function ApplyRequiredSelections(recipeData, selectedRequired)
    local reagentData = recipeData and recipeData.reagentData
    if not reagentData then return end

    for reagentIndex, reagent in ipairs(reagentData.requiredReagents or {}) do
        local option = selectedRequired[reagentIndex]
        if reagent.Clear then reagent:Clear() end
        if option then
            for qualityID, quantity in pairs(option.quantities or {}) do
                if reagent.items and reagent.items[qualityID] then
                    reagent.items[qualityID].quantity = quantity
                end
            end
        elseif not reagent.hasQuality and reagent.items and reagent.items[1] then
            reagent.items[1].quantity = reagent.requiredQuantity
        end
    end

    if recipeData.SetNonQualityReagentsMax then
        recipeData:SetNonQualityReagentsMax()
    end
end

local function GetSlotBySelection(recipeData, selection)
    local reagentData = recipeData and recipeData.reagentData
    if not reagentData or not selection then return nil end

    if selection.group == "requiredSelectable" then
        return reagentData.requiredSelectableReagentSlot
    elseif selection.group == "optional" then
        return reagentData.optionalReagentSlots and reagentData.optionalReagentSlots[selection.slotIndex]
    elseif selection.group == "finishing" then
        return reagentData.finishingReagentSlots and reagentData.finishingReagentSlots[selection.slotIndex]
    end

    return nil
end

local function ApplySlotSelections(recipeData, selectedSlots)
    for _, selection in pairs(selectedSlots) do
        local slot = GetSlotBySelection(recipeData, selection)
        if slot then
            local option = selection.option
            if option.clear then
                slot:SetReagent(nil)
            elseif option.asCurrency then
                slot:SetCurrencyReagent(option.currencyID)
            else
                slot:SetReagent(option.itemID)
            end
        end
    end
end

local function BuildVariantRecord(recipeData)
    UpdateProfit(recipeData)

    local resultData = recipeData.resultData or {}
    local priceData = recipeData.priceData or {}
    local resultItem = GetResultItem(recipeData)
    local expectedQuality = resultData.expectedQuality
    local expectedQualityConcentration = resultData.expectedQualityConcentration
    local resultItemConcentration = GetResultItemByQuality(recipeData, expectedQualityConcentration)
    local resultItemPrice = expectedQuality and priceData.qualityPriceList and priceData.qualityPriceList[expectedQuality] or 0
    local resultItemPriceConcentration = expectedQualityConcentration and priceData.qualityPriceList and
        priceData.qualityPriceList[expectedQualityConcentration] or resultItemPrice
    local effectiveConcentrationCost, expectedIngenuityRefund, ingenuityRefundRate = GetEffectiveConcentrationCost(recipeData)

    return {
        expectedQuality = expectedQuality,
        expectedQualityConcentration = expectedQualityConcentration,
        expectedYieldPerCraft = resultData.expectedYieldPerCraft,
        itemID = resultItem and resultItem.itemID,
        itemName = resultItem and resultItem.itemName,
        itemLink = resultItem and resultItem.itemLink,
        itemIDConcentration = resultItemConcentration and resultItemConcentration.itemID,
        itemNameConcentration = resultItemConcentration and resultItemConcentration.itemName,
        itemLinkConcentration = resultItemConcentration and resultItemConcentration.itemLink,
        averageProfit = recipeData.averageProfitCached or 0,
        relativeProfit = recipeData.relativeProfitCached or 0,
        craftingCosts = priceData.craftingCosts or 0,
        craftingCostsRequired = priceData.craftingCostsRequired or 0,
        craftingCostsFixed = priceData.craftingCostsFixed or 0,
        resultItemPrice = resultItemPrice or 0,
        resultItemPriceConcentration = resultItemPriceConcentration or 0,
        concentration = not not recipeData.concentrating,
        concentrationCost = recipeData.concentrationCost or 0,
        effectiveConcentrationCost = effectiveConcentrationCost,
        expectedIngenuityRefund = expectedIngenuityRefund,
        ingenuityRefundRate = ingenuityRefundRate,
        craftingStats = ExtractCraftingStats(recipeData),
        allocation = ExtractVariantAllocation(recipeData),
    }
end

local function CompareVariantProfit(a, b)
    if (a.averageProfit or 0) ~= (b.averageProfit or 0) then
        return (a.averageProfit or 0) > (b.averageProfit or 0)
    end
    return (a.concentrationCost or 0) < (b.concentrationCost or 0)
end

function Exporter:CalculateIngredientVariants(recipeData, options)
    options = options or {}
    local maxVariants = math.max(1, tonumber(options.maxVariants) or 20000)
    local topN = math.max(1, tonumber(options.topN) or 25)
    local includeOptional = not not options.includeOptional
    local includeFinishing = not not options.includeFinishing
    local timeBudgetMs = math.max(0, tonumber(options.timeBudgetMs) or 0)
    local startedMs = Milliseconds()
    local timeBudgetExceeded = false

    if not recipeData or not recipeData.Copy then
        return nil, "RecipeData cannot be copied."
    end

    local copyOk, workingRecipe = pcall(recipeData.Copy, recipeData)
    if not copyOk or not workingRecipe then
        return nil, "Could not copy RecipeData."
    end

    local dimensions, totalEstimated = BuildVariantDimensions(recipeData, {
        includeOptional = includeOptional,
        includeFinishing = includeFinishing,
    })
    local selectedRequired = {}
    local selectedSlots = {}
    local allVariants = {}
    local tested = 0
    local failed = 0
    local stopped = false

    local function evaluate()
        if tested >= maxVariants then
            stopped = true
            return
        end
        if IsTimeBudgetExceeded(startedMs, timeBudgetMs) then
            stopped = true
            timeBudgetExceeded = true
            return
        end

        tested = tested + 1
        local ok, variant = pcall(function()
            ApplyRequiredSelections(workingRecipe, selectedRequired)
            ApplySlotSelections(workingRecipe, selectedSlots)
            return BuildVariantRecord(workingRecipe)
        end)

        if ok and variant then
            table.insert(allVariants, variant)
        else
            failed = failed + 1
        end

        if IsTimeBudgetExceeded(startedMs, timeBudgetMs) then
            stopped = true
            timeBudgetExceeded = true
        end
    end

    local function recurse(dimensionIndex)
        if stopped then return end
        local dimension = dimensions[dimensionIndex]
        if not dimension then
            evaluate()
            return
        end

        for _, option in ipairs(dimension.options or {}) do
            if dimension.kind == "required" then
                selectedRequired[dimension.reagentIndex] = option
            elseif dimension.kind == "slot" then
                selectedSlots[dimension.key] = {
                    group = dimension.group,
                    slotIndex = dimension.slotIndex,
                    option = option,
                }
            end

            recurse(dimensionIndex + 1)
            if stopped then return end
        end
    end

    recurse(1)

    table.sort(allVariants, CompareVariantProfit)

    for rank, variant in ipairs(allVariants) do
        variant.rank = rank
    end

    return {
        schemaVersion = 2,
        updatedAt = Now(),
        recipeID = recipeData.recipeID,
        recipeName = recipeData.recipeName,
        maxVariants = maxVariants,
        topN = topN,
        exportMode = "all-tested",
        includeOptional = includeOptional,
        includeFinishing = includeFinishing,
        totalEstimated = totalEstimated,
        testedCount = tested,
        failedCount = failed,
        timeBudgetMs = timeBudgetMs > 0 and timeBudgetMs or nil,
        timeBudgetExceeded = timeBudgetExceeded,
        truncated = totalEstimated > tested,
        savedCount = #allVariants,
        variants = allVariants,
    }
end

function Exporter:BuildRecord(recipeData, source)
    if not recipeData or not recipeData.recipeID then return nil end

    UpdateProfit(recipeData)

    local resultData = recipeData.resultData or {}
    local priceData = recipeData.priceData or {}
    local resultItem = GetResultItem(recipeData)
    local expectedQuality = resultData.expectedQuality
    local expectedQualityConcentration = resultData.expectedQualityConcentration
    local resultItemConcentration = GetResultItemByQuality(recipeData, expectedQualityConcentration)
    local resultItemPrice = expectedQuality and priceData.qualityPriceList and priceData.qualityPriceList[expectedQuality] or 0
    local resultItemPriceConcentration = expectedQualityConcentration and priceData.qualityPriceList and
        priceData.qualityPriceList[expectedQualityConcentration] or resultItemPrice
    local effectiveConcentrationCost, expectedIngenuityRefund, ingenuityRefundRate = GetEffectiveConcentrationCost(recipeData)
    local concentrationValue, concentrationProfit = 0, 0
    if recipeData.GetConcentrationValue then
        local ok, value, profit = pcall(recipeData.GetConcentrationValue, recipeData)
        if ok then
            concentrationValue = value or 0
            concentrationProfit = profit or 0
        end
    end

    local professionInfo = recipeData.professionData and recipeData.professionData.professionInfo or {}
    local crafterUID = recipeData.GetCrafterUID and recipeData:GetCrafterUID() or nil

    return {
        exporterVersion = "0.3.0",
        source = source or "manual",
        optimizerSource = "CraftSim",
        exportsAllReagentChoices = true,
        updatedAt = Now(),
        crafterUID = crafterUID,
        profession = professionInfo.profession,
        professionName = professionInfo.professionName or professionInfo.parentProfessionName,
        skillLineID = recipeData.professionData and recipeData.professionData.skillLineID,
        recipeID = recipeData.recipeID,
        recipeName = recipeData.recipeName,
        itemID = resultItem and resultItem.itemID,
        itemName = resultItem and resultItem.itemName,
        itemLink = resultItem and resultItem.itemLink,
        itemIDConcentration = resultItemConcentration and resultItemConcentration.itemID,
        itemNameConcentration = resultItemConcentration and resultItemConcentration.itemName,
        itemLinkConcentration = resultItemConcentration and resultItemConcentration.itemLink,
        expectedQuality = expectedQuality,
        expectedQualityConcentration = expectedQualityConcentration,
        expectedYieldPerCraft = resultData.expectedYieldPerCraft,
        baseItemAmount = recipeData.baseItemAmount,
        averageProfit = recipeData.averageProfitCached or 0,
        relativeProfit = recipeData.relativeProfitCached or 0,
        craftingCosts = priceData.craftingCosts or 0,
        craftingCostsRequired = priceData.craftingCostsRequired or 0,
        craftingCostsFixed = priceData.craftingCostsFixed or 0,
        expectedCostsPerItem = priceData.expectedCostsPerItem or 0,
        resultItemPrice = resultItemPrice or 0,
        resultItemPriceConcentration = resultItemPriceConcentration or 0,
        concentration = not not recipeData.concentrating,
        concentrationCost = recipeData.concentrationCost or 0,
        effectiveConcentrationCost = effectiveConcentrationCost,
        expectedIngenuityRefund = expectedIngenuityRefund,
        ingenuityRefundRate = ingenuityRefundRate,
        concentrationValue = concentrationValue,
        concentrationProfit = concentrationProfit,
        craftingStats = ExtractCraftingStats(recipeData),
        supportsQualities = not not recipeData.supportsQualities,
        supportsMulticraft = not not recipeData.supportsMulticraft,
        supportsResourcefulness = not not recipeData.supportsResourcefulness,
        supportsIngenuity = not not recipeData.supportsIngenuity,
        supportsCraftingStats = not not recipeData.supportsCraftingStats,
        isGear = not not recipeData.isGear,
        isSoulbound = not not recipeData.isSoulbound,
        learned = recipeData.learned,
        maxQuality = recipeData.maxQuality,
        reagents = ExtractReagents(recipeData),
        professionGear = ExtractProfessionGear(recipeData),
    }
end

function Exporter:SaveRecipe(recipeData, source)
    local record = self:BuildRecord(recipeData, source)
    if not record then return false end

    local db = EnsureDB()
    local existingRecord = db.recordsByRecipeID[record.recipeID] or
        (record.itemID and db.recordsByItemID[record.itemID])
    if existingRecord and existingRecord.variantOptimization then
        record.variantOptimization = existingRecord.variantOptimization
    end

    db.recordsByRecipeID[record.recipeID] = record
    if record.itemID then
        db.recordsByItemID[record.itemID] = record
    end
    db.lastExportAt = record.updatedAt
    db.lastExportSource = source or "manual"
    return true, record
end

function Exporter:SaveRecipeVariants(recipeData, source, options)
    options = options or {}
    local ok, record = self:SaveRecipe(recipeData, source or "ingredient-variants")
    if not ok or not record then return false end

    local variantOptimization, errorMessage = self:CalculateIngredientVariants(recipeData, options)
    if not variantOptimization then
        if not options.quiet then
            Print(errorMessage or "variant calculation failed.")
        end
        return false
    end

    record.variantOptimization = variantOptimization

    local db = EnsureDB()
    db.recordsByRecipeID[record.recipeID] = record
    if record.itemID then
        db.recordsByItemID[record.itemID] = record
    end
    table.insert(db.variantExports, {
        updatedAt = Now(),
        source = source or "ingredient-variants",
        recipeID = record.recipeID,
        recipeName = record.recipeName,
        testedCount = variantOptimization.testedCount,
        totalEstimated = variantOptimization.totalEstimated,
        truncated = variantOptimization.truncated,
        timeBudgetExceeded = variantOptimization.timeBudgetExceeded,
    })

    if not options.quiet then
        Print("tested " .. tostring(variantOptimization.testedCount) .. "/" ..
            tostring(variantOptimization.totalEstimated) .. " ingredient variant(s) for " ..
            tostring(record.recipeName or record.recipeID) .. ".")
    end
    return true, record
end

function Exporter:GetCraftSim()
    if not CraftSimAPI or not CraftSimAPI.GetCraftSim then return nil end
    local ok, craftSim = pcall(CraftSimAPI.GetCraftSim, CraftSimAPI)
    if ok then return craftSim end
    return nil
end

function Exporter:ExportOpenRecipe()
    if not CraftSimAPI or not CraftSimAPI.GetOpenRecipeData then
        Print("CraftSimAPI is not available.")
        return
    end

    local recipeData = CraftSimAPI:GetOpenRecipeData()
    if not recipeData then
        Print("No open CraftSim recipe data found.")
        return
    end

    local ok, record = self:SaveRecipe(recipeData, "open-recipe")
    if ok then
        Print("exported " .. tostring(record.recipeName or record.recipeID))
    end
end

function Exporter:GetSelectedRecipeScanRow()
    local professionList = self:GetRecipeScanProfessionList()
    return professionList and professionList.selectedRow or nil
end

function Exporter:GetRecipeScanProfessionList()
    local CraftSim = self:GetCraftSim()
    local frame = CraftSim and CraftSim.RECIPE_SCAN and CraftSim.RECIPE_SCAN.frame
    local tab = frame and frame.content and frame.content.recipeScanTab
    local content = tab and tab.content
    return content and content.professionList or nil
end

function Exporter:RefreshCraftSimRecipeScanList()
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSim.RECIPE_SCAN then return false end

    if ProfessionsFrame and ProfessionsFrame.IsShown and ProfessionsFrame:IsShown() and CraftSim.MODULES then
        if CraftSim.MODULES.ShowRecipeIndependentModules then
            pcall(CraftSim.MODULES.ShowRecipeIndependentModules, CraftSim.MODULES)
        end
        if CraftSim.MODULES.UpdateUI then
            pcall(CraftSim.MODULES.UpdateUI, CraftSim.MODULES)
        end
    end

    local frame = CraftSim.RECIPE_SCAN.frame
    if frame and frame.SetVisible then
        pcall(frame.SetVisible, frame, true)
    end

    local frameObject = frame and (frame.frame or frame)
    if frameObject and frameObject.Show then
        pcall(frameObject.Show, frameObject)
    end

    local hasOpenProfession = C_TradeSkillUI and C_TradeSkillUI.GetBaseProfessionInfo and C_TradeSkillUI.GetBaseProfessionInfo()
    if hasOpenProfession and CraftSim.RECIPE_SCAN.UpdateProfessionListByCache then
        pcall(CraftSim.RECIPE_SCAN.UpdateProfessionListByCache, CraftSim.RECIPE_SCAN)
    end

    if CraftSim.RECIPE_SCAN.UI and CraftSim.RECIPE_SCAN.UI.UpdateProfessionList then
        pcall(CraftSim.RECIPE_SCAN.UI.UpdateProfessionList, CraftSim.RECIPE_SCAN.UI, false)
    end

    return true
end

function Exporter:GetCraftSimIncludedProfessions()
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSim.DB or not CraftSim.DB.OPTIONS or not CraftSim.DB.OPTIONS.Get then
        return nil
    end

    local ok, includedProfessions = pcall(CraftSim.DB.OPTIONS.Get, CraftSim.DB.OPTIONS, "RECIPESCAN_INCLUDED_PROFESSIONS")
    if ok then return includedProfessions end
    return nil
end

function Exporter:GetPlayerCrafterUID()
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSim.UTIL or not CraftSim.UTIL.GetPlayerCrafterUID then
        local playerName = UnitName and UnitName("player") or nil
        local realmName = GetNormalizedRealmName and GetNormalizedRealmName() or GetRealmName and GetRealmName() or nil
        if playerName and realmName then
            return tostring(playerName) .. "-" .. tostring(realmName)
        end
        return nil
    end

    local ok, playerCrafterUID = pcall(CraftSim.UTIL.GetPlayerCrafterUID, CraftSim.UTIL)
    if ok then return playerCrafterUID end
    return nil
end

function Exporter:BuildVisibleProfessionConcentrationSnapshot()
    if not C_TradeSkillUI or not C_TradeSkillUI.GetConcentrationCurrencyID or not C_CurrencyInfo or
        not C_CurrencyInfo.GetCurrencyInfo then
        return nil
    end

    local professionInfo = self:GetCurrentBlizzardProfessionInfo()
    if not professionInfo then return nil end

    local professionID = tonumber(professionInfo.professionID)
    if not professionID or professionID <= 0 then return nil end

    local currencyID = C_TradeSkillUI.GetConcentrationCurrencyID(professionID)
    if not currencyID or currencyID == 0 then return nil end

    local currencyInfo = C_CurrencyInfo.GetCurrencyInfo(currencyID)
    if not currencyInfo then return nil end

    local CraftSim = self:GetCraftSim()
    local expansionID = nil
    if CraftSim and CraftSim.UTIL and CraftSim.UTIL.GetExpansionIDBySkillLineID then
        local ok, value = pcall(CraftSim.UTIL.GetExpansionIDBySkillLineID, CraftSim.UTIL, professionID)
        if ok then expansionID = value end
    end

    local now = Now()
    local amount = tonumber(currencyInfo.quantity) or 0
    local maxQuantity = tonumber(currencyInfo.maxQuantity) or amount
    local rechargeTimePerPointMS = tonumber(currencyInfo.rechargingCycleDurationMS) or 0

    return {
        schemaVersion = 1,
        source = "blizzard-professions-ui",
        updatedAt = now,
        lastUpdated = now,
        crafterUID = self:GetPlayerCrafterUID(),
        playerKey = GetPlayerMetaKey(),
        profession = professionInfo.profession or professionID,
        professionID = professionID,
        professionName = professionInfo.professionName or professionInfo.parentProfessionName or professionInfo.displayName,
        skillLineID = professionID,
        expansionID = expansionID,
        currencyID = currencyID,
        currencyName = currencyInfo.name,
        amount = amount,
        currentAmount = amount,
        currentAmountRounded = math.floor(amount),
        maxQuantity = maxQuantity,
        rechargeTimePerPointMS = rechargeTimePerPointMS,
    }
end

function Exporter:BuildCraftSimConcentrationSnapshots()
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSimDB or not CraftSimDB.crafterDB or not CraftSimDB.crafterDB.data then
        return {}
    end

    local crafterUID = self:GetPlayerCrafterUID()
    local crafterData = crafterUID and CraftSimDB.crafterDB.data[crafterUID]
    local concentrationDataByExpansion = crafterData and crafterData.concentrationData
    if not concentrationDataByExpansion then return {} end

    local snapshots = {}
    for expansionID, professionMap in pairs(concentrationDataByExpansion) do
        if type(professionMap) == "table" then
            for profession, serialized in pairs(professionMap) do
                if type(serialized) == "table" and serialized.currencyID then
                    local currencyInfo = C_CurrencyInfo and C_CurrencyInfo.GetCurrencyInfo and
                        C_CurrencyInfo.GetCurrencyInfo(serialized.currencyID) or nil
                    local liveAmount = currencyInfo and tonumber(currencyInfo.quantity) or nil
                    local liveMaxQuantity = currencyInfo and tonumber(currencyInfo.maxQuantity) or nil
                    local liveRechargeTimePerPointMS = currencyInfo and tonumber(currencyInfo.rechargingCycleDurationMS) or nil
                    local amount = liveAmount or tonumber(serialized.amount) or 0
                    local maxQuantity = liveMaxQuantity or tonumber(serialized.maxQuantity) or amount
                    local rechargeTimePerPointMS = liveRechargeTimePerPointMS or tonumber(serialized.rechargeTimePerPoint) or 0
                    local lastUpdated = liveAmount and Now() or serialized.lastUpdated
                    local currentAmount = liveAmount or EstimateConcentrationAmount(
                        serialized.amount,
                        serialized.lastUpdated,
                        serialized.maxQuantity,
                        serialized.rechargeTimePerPoint)
                    table.insert(snapshots, {
                        schemaVersion = 1,
                        source = liveAmount and "craftsim-currency-live" or "craftsim-cache",
                        updatedAt = Now(),
                        lastUpdated = lastUpdated,
                        crafterUID = crafterUID,
                        playerKey = GetPlayerMetaKey(),
                        profession = tonumber(profession) or profession,
                        expansionID = tonumber(expansionID) or expansionID,
                        currencyID = serialized.currencyID,
                        currencyName = currencyInfo and currencyInfo.name,
                        amount = amount,
                        currentAmount = currentAmount,
                        currentAmountRounded = math.floor(currentAmount),
                        maxQuantity = maxQuantity,
                        rechargeTimePerPointMS = rechargeTimePerPointMS,
                    })
                end
            end
        end
    end

    return snapshots
end

function Exporter:SaveConcentrationSnapshot(snapshot)
    if not snapshot or not snapshot.currencyID then return nil end

    local db = EnsureDB()
    db.concentrationByCrafter = db.concentrationByCrafter or {}
    local crafterUID = snapshot.crafterUID or "unknown"
    local professionKey = tostring(snapshot.profession or snapshot.currencyID or "unknown")
    db.concentrationByCrafter[crafterUID] = db.concentrationByCrafter[crafterUID] or {}
    if ShouldReplaceConcentrationSnapshot(snapshot, db.concentrationByCrafter[crafterUID][professionKey]) then
        db.concentrationByCrafter[crafterUID][professionKey] = snapshot
    end

    local current = db.concentration
    if ShouldReplaceConcentrationSnapshot(snapshot, current) then
        db.concentration = snapshot
        db.meta = db.meta or {}
        db.meta.concentration = snapshot
    end

    local characterKey = GetPlayerMetaKey()
    db.characters = db.characters or {}
    db.characters[characterKey] = db.characters[characterKey] or SavePlayerMeta()
    db.characters[characterKey].concentrationByProfession = db.characters[characterKey].concentrationByProfession or {}
    if ShouldReplaceConcentrationSnapshot(snapshot, db.characters[characterKey].concentrationByProfession[professionKey]) then
        db.characters[characterKey].concentrationByProfession[professionKey] = snapshot
    end
    if ShouldReplaceConcentrationSnapshot(snapshot, db.characters[characterKey].concentration) then
        db.characters[characterKey].concentration = snapshot
    end
    return snapshot
end

function Exporter:SaveCurrentConcentration(quiet)
    local saved = 0
    local latest = nil

    for _, snapshot in ipairs(self:BuildCraftSimConcentrationSnapshots()) do
        latest = self:SaveConcentrationSnapshot(snapshot) or latest
        saved = saved + 1
    end

    local visibleSnapshot = self:BuildVisibleProfessionConcentrationSnapshot()
    if visibleSnapshot then
        latest = self:SaveConcentrationSnapshot(visibleSnapshot)
        saved = saved + 1
    end

    if latest and not quiet then
        Print("saved concentration: " .. tostring(latest.currentAmountRounded or 0) .. "/" ..
            tostring(latest.maxQuantity or 0) .. " (" .. tostring(latest.source or "unknown") ..
            ", currency " .. tostring(latest.currencyID or "?") .. ").")
    elseif not latest and not quiet then
        Print("No current concentration found. Open a profession window once, then try again.")
    end

    self:RefreshPanel()
    return latest, saved
end

function Exporter:GetSavedConcentrationSummary()
    local db = EnsureDB()
    local snapshot = db.concentration
    if not snapshot then return nil end

    local currentAmount = EstimateConcentrationAmount(
        snapshot.amount or snapshot.currentAmount,
        snapshot.lastUpdated or snapshot.updatedAt,
        snapshot.maxQuantity,
        snapshot.rechargeTimePerPointMS)
    return {
        currentAmount = currentAmount,
        currentAmountRounded = math.floor(currentAmount),
        maxQuantity = tonumber(snapshot.maxQuantity) or 0,
        professionName = snapshot.professionName,
        profession = snapshot.profession,
    }
end

function Exporter:SetRecipeScanRowChecked(row, checked, includedProfessions)
    local checkboxColumn = row and row.columns and row.columns[1]
    local checkbox = checkboxColumn and checkboxColumn.checkbox
    if not checkbox then return end

    self.recipeScanCheckboxRestore = self.recipeScanCheckboxRestore or {}
    local restoreKey = row.crafterProfessionUID or tostring(row)
    if not self.recipeScanCheckboxRestore[restoreKey] then
        local wasChecked = nil
        if checkbox.GetChecked then
            local ok, value = pcall(checkbox.GetChecked, checkbox)
            if ok then wasChecked = value end
        end

        self.recipeScanCheckboxRestore[restoreKey] = {
            checkbox = checkbox,
            checked = wasChecked,
            includedProfessions = includedProfessions,
            crafterProfessionUID = row.crafterProfessionUID,
            includedValue = includedProfessions and row.crafterProfessionUID and includedProfessions[row.crafterProfessionUID],
        }
    end

    if checkbox.SetChecked then
        pcall(checkbox.SetChecked, checkbox, checked)
    end
    if includedProfessions and row.crafterProfessionUID then
        includedProfessions[row.crafterProfessionUID] = checked
    end
end

function Exporter:RestoreRecipeScanCheckboxes()
    if not self.recipeScanCheckboxRestore then return end

    for _, entry in pairs(self.recipeScanCheckboxRestore) do
        if entry.checkbox and entry.checkbox.SetChecked then
            pcall(entry.checkbox.SetChecked, entry.checkbox, entry.checked)
        end
        if entry.includedProfessions and entry.crafterProfessionUID then
            entry.includedProfessions[entry.crafterProfessionUID] = entry.includedValue
        end
    end

    self.recipeScanCheckboxRestore = nil
end

function Exporter:PrepareRecipeScanProfessionRows()
    local professionList = self:GetRecipeScanProfessionList()
    local activeRows = professionList and professionList.activeRows
    if not activeRows or #activeRows <= 0 then
        return 0, 0, false
    end

    local playerCrafterUID = self:GetPlayerCrafterUID()
    local hasCurrentCharacterRows = false
    for _, row in ipairs(activeRows) do
        if row and playerCrafterUID and row.crafterUID == playerCrafterUID then
            hasCurrentCharacterRows = true
            break
        end
    end

    local includedProfessions = self:GetCraftSimIncludedProfessions()
    local scanCount = 0
    local firstScanIndex = nil

    for index, row in ipairs(activeRows) do
        local shouldScan = row ~= nil
        if hasCurrentCharacterRows then
            shouldScan = row and row.crafterUID == playerCrafterUID
        end

        self:SetRecipeScanRowChecked(row, shouldScan, includedProfessions)
        if shouldScan then
            scanCount = scanCount + 1
            firstScanIndex = firstScanIndex or index
        end
    end

    if firstScanIndex and professionList.SelectRow then
        pcall(professionList.SelectRow, professionList, firstScanIndex)
    end

    return scanCount, #activeRows, hasCurrentCharacterRows
end

function Exporter:ExportRecipeScanRow(row, source)
    row = row or self:GetSelectedRecipeScanRow()
    if not row or not row.currentResults then
        Print("No selected Recipe Scan results found.")
        return 0
    end

    local count = 0
    for _, recipeData in ipairs(row.currentResults) do
        if self:SaveRecipe(recipeData, source or "recipe-scan") then
            count = count + 1
        end
    end

    local db = EnsureDB()
    table.insert(db.scanExports, {
        updatedAt = Now(),
        source = source or "recipe-scan",
        crafterUID = row.crafterUID,
        profession = row.profession,
        count = count,
    })

    Print("exported " .. tostring(count) .. " Recipe Scan result(s).")
    return count
end

local function ParseVariantOptions(message, defaultMaxVariants)
    local options = {
        maxVariants = defaultMaxVariants or 20000,
        topN = 25,
        includeOptional = false,
        includeFinishing = false,
    }

    for token in string.gmatch(message or "", "%S+") do
        local numeric = tonumber(token)
        if numeric then
            options.maxVariants = numeric
        elseif token == "all" then
            options.includeOptional = true
            options.includeFinishing = true
        elseif token == "optional" then
            options.includeOptional = true
        elseif token == "finishing" then
            options.includeFinishing = true
        elseif string.match(token, "^top=%d+$") then
            options.topN = tonumber(string.match(token, "^top=(%d+)$")) or options.topN
        end
    end

    return options
end

function Exporter:GetVariantOptionsMessage(defaultMaxVariants)
    local db = EnsureDB()
    local settings = db.settings or {}
    local maxVariants = math.max(1, tonumber(settings.variantMaxVariants) or defaultMaxVariants or 5000)
    local topN = math.max(1, tonumber(settings.variantTopN) or 25)
    local parts = { tostring(maxVariants) }

    if settings.includeOptionalVariants and settings.includeFinishingVariants then
        table.insert(parts, "all")
    elseif settings.includeOptionalVariants then
        table.insert(parts, "optional")
    elseif settings.includeFinishingVariants then
        table.insert(parts, "finishing")
    end

    table.insert(parts, "top=" .. tostring(topN))
    return table.concat(parts, " ")
end

function Exporter:SavePanelSettings()
    local db = EnsureDB()
    local settings = db.settings
    local panel = self.panel
    if not panel then return end

    if panel.maxVariantsBox then
        settings.variantMaxVariants = math.max(1, tonumber(panel.maxVariantsBox:GetText()) or settings.variantMaxVariants or 5000)
        panel.maxVariantsBox:SetText(tostring(settings.variantMaxVariants))
    end

    if panel.topNBox then
        settings.variantTopN = math.max(1, tonumber(panel.topNBox:GetText()) or settings.variantTopN or 25)
        panel.topNBox:SetText(tostring(settings.variantTopN))
    end

    if panel.optionalCheck then
        settings.includeOptionalVariants = not not panel.optionalCheck:GetChecked()
    end

    if panel.finishingCheck then
        settings.includeFinishingVariants = not not panel.finishingCheck:GetChecked()
    end

    if panel.autoScanCheck then
        settings.autoVariantsOnRecipeScan = not not panel.autoScanCheck:GetChecked()
    end
end

function Exporter:ExportOpenRecipeVariants(message)
    if not CraftSimAPI or not CraftSimAPI.GetOpenRecipeData then
        Print("CraftSimAPI is not available.")
        return
    end

    local recipeData = CraftSimAPI:GetOpenRecipeData()
    if not recipeData then
        Print("No open CraftSim recipe data found.")
        return
    end

    if not message or message == "" then
        message = self:GetVariantOptionsMessage(20000)
    end

    local options = ParseVariantOptions(message, 20000)
    self:SaveRecipeVariants(recipeData, "open-recipe-variants", options)
end

function Exporter:ExportRecipeScanVariants(row, message)
    row = row or self:GetSelectedRecipeScanRow()
    if not row or not row.currentResults then
        Print("No selected Recipe Scan results found.")
        return 0
    end

    if not message or message == "" then
        message = self:GetVariantOptionsMessage(5000)
    end

    return self:QueueRecipeScanVariants(row, message)
end

local function CopyOptions(options)
    local copy = {}
    for key, value in pairs(options or {}) do
        copy[key] = value
    end
    return copy
end

function Exporter:QueueRecipeScanVariants(row, message)
    if not row or not row.currentResults then
        Print("No Recipe Scan results found.")
        return 0
    end

    local results = {}
    for _, recipeData in ipairs(row.currentResults) do
        table.insert(results, recipeData)
    end

    if #results == 0 then
        Print("No Recipe Scan result recipes found.")
        return 0
    end

    local options = ParseVariantOptions(message, 5000)
    options.timeBudgetMs = VARIANT_RECIPE_TIME_BUDGET_MS
    options.quiet = true

    self.recipeScanVariantQueue = self.recipeScanVariantQueue or { jobs = {} }
    table.insert(self.recipeScanVariantQueue.jobs, {
        results = results,
        index = 1,
        saved = 0,
        failed = 0,
        timeLimited = 0,
        total = #results,
        source = "recipe-scan-variants",
        options = options,
    })

    Print("queued ingredient variants for " .. tostring(#results) .. " Recipe Scan result(s). Wait for the saved message, then type /reload.")
    self:ScheduleRecipeScanVariantQueue()
    return #results
end

function Exporter:ScheduleRecipeScanVariantQueue()
    if self.recipeScanVariantScheduled then return end
    self.recipeScanVariantScheduled = true

    if C_Timer and C_Timer.After then
        C_Timer.After(RECIPE_SCAN_VARIANT_DELAY_SECONDS, function()
            Exporter.recipeScanVariantScheduled = false
            Exporter:ProcessRecipeScanVariantQueue()
        end)
    else
        self.recipeScanVariantScheduled = false
        self:ProcessRecipeScanVariantQueue()
    end
end

function Exporter:FinishRecipeScanVariantJob(job)
    local message = "saved ingredient variants for " .. tostring(job.saved) .. "/" ..
        tostring(job.total) .. " Recipe Scan result(s)"
    if job.failed > 0 then
        message = message .. "; " .. tostring(job.failed) .. " failed"
    end
    if job.timeLimited > 0 then
        message = message .. "; " .. tostring(job.timeLimited) .. " time-limited"
    end
    Print(message .. ". Type /reload before generating the report.")
end

function Exporter:ProcessRecipeScanVariantQueue()
    local queue = self.recipeScanVariantQueue
    if not queue or not queue.jobs or #queue.jobs == 0 then
        self.recipeScanVariantQueue = nil
        self:RefreshPanel()
        return
    end

    local job = queue.jobs[1]
    local recipeData = job.results[job.index]
    if not recipeData then
        self:FinishRecipeScanVariantJob(job)
        table.remove(queue.jobs, 1)
        self:ScheduleRecipeScanVariantQueue()
        return
    end

    local options = CopyOptions(job.options)
    local ok, saved, record = pcall(self.SaveRecipeVariants, self, recipeData, job.source, options)
    if ok and saved then
        job.saved = job.saved + 1
        local optimization = record and record.variantOptimization
        if optimization and optimization.timeBudgetExceeded then
            job.timeLimited = job.timeLimited + 1
        end
    else
        job.failed = job.failed + 1
        if not ok then
            Print("variant save failed: " .. tostring(saved))
        end
    end

    job.index = job.index + 1
    self:SetStatus("Saving variants " .. tostring(job.index - 1) .. "/" .. tostring(job.total) .. "...")
    self:ScheduleRecipeScanVariantQueue()
end

function Exporter:OpenCraftSimRecipeScan()
    if self:RefreshCraftSimRecipeScanList() then
        Print("opened and refreshed CraftSim Recipe Scan.")
        return true
    end

    Print("Open the profession window and CraftSim Recipe Scan once, then try again.")
    return false
end

function Exporter:RunSelectedRecipeScanWithVariants()
    local CraftSim = self:GetCraftSim()
    local row = self:GetSelectedRecipeScanRow()
    if not CraftSim or not CraftSim.RECIPE_SCAN or not CraftSim.RECIPE_SCAN.ScanRow then
        Print("CraftSim Recipe Scan is not available.")
        return
    end
    if not row then
        Print("Select a CraftSim Recipe Scan profession row first.")
        return
    end

    self:SavePanelSettings()
    self.pendingRecipeScanVariants = true
    CraftSim.RECIPE_SCAN:ScanRow(row)
    Print("started selected Recipe Scan; variants will save when it finishes.")
end

function Exporter:RunAllRecipeScanWithVariants()
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSim.RECIPE_SCAN or not CraftSim.RECIPE_SCAN.ScanProfessions then
        Print("CraftSim Recipe Scan is not available.")
        return
    end
    if CraftSim.RECIPE_SCAN.isScanning or CraftSim.RECIPE_SCAN.isScanningProfessions then
        Print("CraftSim Recipe Scan is already running.")
        return
    end

    self:SavePanelSettings()
    self:SaveCurrentConcentration(true)
    self.pendingRecipeScanVariants = true
    self:RefreshCraftSimRecipeScanList()
    Print("preparing CraftSim profession rows...")

    C_Timer.After(0.75, function()
        local CurrentCraftSim = Exporter:GetCraftSim()
        if not CurrentCraftSim or not CurrentCraftSim.RECIPE_SCAN or not CurrentCraftSim.RECIPE_SCAN.ScanProfessions then
            Exporter.pendingRecipeScanVariants = false
            Exporter:RestoreRecipeScanCheckboxes()
            Print("CraftSim Recipe Scan is not available.")
            return
        end

        local scanCount, totalRows, currentCharacterOnly = Exporter:PrepareRecipeScanProfessionRows()
        if scanCount <= 0 then
            Exporter.pendingRecipeScanVariants = false
            Exporter:RestoreRecipeScanCheckboxes()
            Print("No CraftSim profession rows found. Open your profession window once, then try again.")
            return
        end

        local ok, err = pcall(CurrentCraftSim.RECIPE_SCAN.ScanProfessions, CurrentCraftSim.RECIPE_SCAN)
        if not ok then
            Exporter.pendingRecipeScanVariants = false
            Exporter:RestoreRecipeScanCheckboxes()
            Print("CraftSim profession scan failed: " .. tostring(err))
            return
        end

        local scope = currentCharacterOnly and "current-character" or "visible"
        Print("started CraftSim scan for " .. tostring(scanCount) .. "/" .. tostring(totalRows) ..
            " " .. scope .. " profession row(s); variants will save as each scan finishes.")
    end)
end

function Exporter:OnRecipeScanComplete(row, source)
    self:SaveCurrentConcentration(true)

    local db = EnsureDB()
    if self.pendingRecipeScanVariants or db.settings.autoVariantsOnRecipeScan then
        self:QueueRecipeScanVariants(row, self:GetVariantOptionsMessage(5000))
    else
        self:ExportRecipeScanRow(row, source or "recipe-scan-complete")
    end

    local CraftSim = self:GetCraftSim()
    if not (CraftSim and CraftSim.RECIPE_SCAN and CraftSim.RECIPE_SCAN.isScanningProfessions) then
        self.pendingRecipeScanVariants = false
        self:RestoreRecipeScanCheckboxes()
    end

    self:RefreshPanel()
end

function Exporter:Stats()
    self:SaveCurrentConcentration(true)
    local db = EnsureDB()
    local recipes, items = 0, 0
    for _ in pairs(db.recordsByRecipeID) do recipes = recipes + 1 end
    for _ in pairs(db.recordsByItemID) do items = items + 1 end
    local concentration = self:GetSavedConcentrationSummary()
    local concentrationText = ""
    if concentration then
        concentrationText = " Concentration: " .. tostring(concentration.currentAmountRounded or 0) .. "/" ..
            tostring(concentration.maxQuantity or 0) .. "."
    end
    Print("records: " .. recipes .. " recipe(s), " .. items .. " item(s). Last export: " ..
        tostring(db.lastExportAt or 0) .. "." .. concentrationText)
end

function Exporter:Clear()
    local settings = EnsureDB().settings
    CraftPlanExporterDB = {
        schemaVersion = 1,
        recordsByItemID = {},
        recordsByRecipeID = {},
        scanExports = {},
        variantExports = {},
        meta = CraftPlanExporterDB and CraftPlanExporterDB.meta or {},
        characters = CraftPlanExporterDB and CraftPlanExporterDB.characters or {},
        settings = settings,
        lastExportAt = 0,
    }
    Print("cleared exported data.")
    self:RefreshPanel()
end

local function CreatePanelText(parent, text, point, relativeTo, relativePoint, x, y, width)
    local fontString = parent:CreateFontString(nil, "ARTWORK", "GameFontNormal")
    fontString:SetPoint(point, relativeTo or parent, relativePoint or point, x or 0, y or 0)
    fontString:SetText(text)
    if width then
        fontString:SetWidth(width)
        fontString:SetJustifyH("LEFT")
    end
    return fontString
end

local function CreatePanelButton(parent, label, x, y, width, onClick)
    local button = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
    button:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    button:SetSize(width or 170, 24)
    button:SetText(label)
    button:SetScript("OnClick", onClick)
    return button
end

local function CreatePanelCheck(parent, label, x, y, onClick)
    local check = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
    check:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    check:SetSize(24, 24)
    if check.Text then
        check.Text:SetText(label)
    else
        check.text = CreatePanelText(check, label, "LEFT", check, "RIGHT", 4, 0, 220)
    end
    check:SetScript("OnClick", onClick)
    return check
end

local function CreatePanelInput(parent, label, x, y, value)
    CreatePanelText(parent, label, "TOPLEFT", parent, "TOPLEFT", x, y + 2, 110)
    local editBox = CreateFrame("EditBox", nil, parent, "InputBoxTemplate")
    editBox:SetPoint("TOPLEFT", parent, "TOPLEFT", x + 112, y + 4)
    editBox:SetSize(76, 24)
    editBox:SetAutoFocus(false)
    if editBox.SetNumeric then editBox:SetNumeric(true) end
    editBox:SetText(tostring(value or ""))
    editBox:SetCursorPosition(0)
    editBox:SetScript("OnEnterPressed", function(self)
        Exporter:SavePanelSettings()
        self:ClearFocus()
    end)
    editBox:SetScript("OnEscapePressed", function(self)
        self:ClearFocus()
    end)
    return editBox
end

local function CreatePanelMultilineInput(parent, x, y, width, height)
    local backdrop = CreateFrame("Frame", nil, parent, "BackdropTemplate")
    backdrop:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    backdrop:SetSize(width, height)
    if backdrop.SetBackdrop then
        backdrop:SetBackdrop({
            bgFile = "Interface\\Buttons\\WHITE8X8",
            edgeFile = "Interface\\Buttons\\WHITE8X8",
            edgeSize = 1,
        })
        backdrop:SetBackdropColor(0.02, 0.03, 0.025, 0.9)
        backdrop:SetBackdropBorderColor(0.3, 0.3, 0.3, 0.8)
    end

    local scrollFrame = CreateFrame("ScrollFrame", nil, parent, "UIPanelScrollFrameTemplate")
    scrollFrame:SetPoint("TOPLEFT", backdrop, "TOPLEFT", 6, -6)
    scrollFrame:SetPoint("BOTTOMRIGHT", backdrop, "BOTTOMRIGHT", -26, 6)

    local editBox = CreateFrame("EditBox", nil, scrollFrame)
    editBox:SetMultiLine(true)
    editBox:SetAutoFocus(false)
    editBox:SetFontObject(ChatFontNormal)
    editBox:SetWidth(width - 36)
    editBox:SetHeight(height - 12)
    editBox:SetTextInsets(2, 2, 2, 2)
    editBox:SetScript("OnEscapePressed", function(self)
        self:ClearFocus()
    end)
    editBox:SetScript("OnTextChanged", function(self)
        local lineHeight = 14
        if self.GetNumLines then
            self:SetHeight(math.max(height - 12, self:GetNumLines() * lineHeight + 18))
        end
    end)
    scrollFrame:SetScrollChild(editBox)
    return editBox
end

local function Trim(value)
    return tostring(value or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function SplitTabLine(line)
    local fields = {}
    local start = 1

    while true do
        local tabStart = string.find(line, "\t", start, true)
        if not tabStart then
            table.insert(fields, string.sub(line, start))
            break
        end

        table.insert(fields, string.sub(line, start, tabStart - 1))
        start = tabStart + 1
    end

    return fields
end

local function ParseShoppingPayload(text)
    local valid = false
    local listName = "CraftPlan Mats"
    local itemsByKey = {}
    local orderedKeys = {}

    for line in tostring(text or ""):gmatch("[^\r\n]+") do
        line = Trim(line)
        if line == "CPE_AUCTIONATOR_LIST_V1" then
            valid = true
        else
            local fields = SplitTabLine(line)
            local kind = fields[1]
            if kind == "list" and Trim(fields[2]) ~= "" then
                listName = Trim(fields[2])
            elseif kind == "item" then
                local name = Trim(fields[2])
                local tier = math.max(0, tonumber(fields[3]) or 0)
                local quantity = math.max(1, math.ceil(tonumber(fields[4]) or 1))
                if name ~= "" then
                    local key = string.lower(name) .. ":" .. tostring(tier)
                    if not itemsByKey[key] then
                        itemsByKey[key] = { name = name, tier = tier, quantity = 0 }
                        table.insert(orderedKeys, key)
                    end
                    itemsByKey[key].quantity = itemsByKey[key].quantity + quantity
                end
            end
        end
    end

    local items = {}
    for _, key in ipairs(orderedKeys) do
        table.insert(items, itemsByKey[key])
    end

    return valid, listName, items
end

local function GetAuctionatorAPI()
    return Auctionator and Auctionator.API and Auctionator.API.v1
end

function Exporter:CreateAuctionatorShoppingListFromText(text)
    local api = GetAuctionatorAPI()
    if not api or not api.CreateShoppingList or not api.ConvertToSearchString then
        Print("Auctionator API is not available. Make sure Auctionator is enabled.")
        return false
    end

    local valid, listName, items = ParseShoppingPayload(text)
    if not valid or #items == 0 then
        Print("Paste a CPE mats list copied from the report first.")
        return false
    end

    local searchStrings = {}
    for _, item in ipairs(items) do
        local term = {
            searchString = item.name,
            isExact = true,
            categoryKey = "",
            quantity = item.quantity,
        }
        if item.tier and item.tier > 0 then
            term.tier = item.tier
        end

        local ok, searchString = pcall(api.ConvertToSearchString, "CraftPlanExporter", term)
        if ok and searchString then
            table.insert(searchStrings, searchString)
        else
            Print("could not convert shopping item: " .. tostring(item.name))
        end
    end

    if #searchStrings == 0 then
        Print("No Auctionator search terms were created.")
        return false
    end

    local ok, err = pcall(api.CreateShoppingList, "CraftPlanExporter", listName, searchStrings)
    if not ok then
        Print("Auctionator list failed: " .. tostring(err))
        return false
    end

    Print("created Auctionator list '" .. listName .. "' with " .. tostring(#searchStrings) .. " item(s).")
    return true
end

function Exporter:CreateShoppingListFromPanel()
    if not self.panel or not self.panel.shoppingListBox then
        Print("Open the CPE panel first.")
        return
    end

    self:CreateAuctionatorShoppingListFromText(self.panel.shoppingListBox:GetText())
end

function Exporter:GetRecordCounts()
    local db = EnsureDB()
    local recipes, items = 0, 0
    for _ in pairs(db.recordsByRecipeID or {}) do recipes = recipes + 1 end
    for _ in pairs(db.recordsByItemID or {}) do items = items + 1 end
    return recipes, items
end

function Exporter:RefreshPanel()
    local panel = self.panel
    if not panel then return end

    local db = EnsureDB()
    local settings = db.settings or {}
    local recipes, items = self:GetRecordCounts()

    if panel.countText then
        local concentration = self:GetSavedConcentrationSummary()
        local concentrationText = ""
        if concentration then
            concentrationText = " | Conc: " .. tostring(concentration.currentAmountRounded or 0) .. "/" ..
                tostring(concentration.maxQuantity or 0)
        end
        panel.countText:SetText("Saved: " .. tostring(recipes) .. " recipes, " .. tostring(items) .. " items" ..
            concentrationText)
    end
    if panel.statusText then
        panel.statusText:SetText(self.lastStatus or "Ready.")
    end
    if panel.maxVariantsBox and not panel.maxVariantsBox:HasFocus() then
        panel.maxVariantsBox:SetText(tostring(settings.variantMaxVariants or 5000))
    end
    if panel.topNBox and not panel.topNBox:HasFocus() then
        panel.topNBox:SetText(tostring(settings.variantTopN or 25))
    end
    if panel.optionalCheck then
        panel.optionalCheck:SetChecked(settings.includeOptionalVariants)
    end
    if panel.finishingCheck then
        panel.finishingCheck:SetChecked(settings.includeFinishingVariants)
    end
    if panel.autoScanCheck then
        panel.autoScanCheck:SetChecked(settings.autoVariantsOnRecipeScan)
    end
end

function Exporter:CreatePanel()
    if self.panel then return self.panel end

    local db = EnsureDB()
    local settings = db.settings or {}
    local panel = CreateFrame("Frame", "CraftPlanExporterPanel", UIParent, "BasicFrameTemplateWithInset")
    panel:SetSize(500, 370)
    panel:SetPoint("CENTER")
    panel:SetFrameStrata("DIALOG")
    panel:SetMovable(true)
    panel:EnableMouse(true)
    panel:RegisterForDrag("LeftButton")
    panel:SetScript("OnDragStart", panel.StartMoving)
    panel:SetScript("OnDragStop", panel.StopMovingOrSizing)
    panel:SetScript("OnShow", function()
        Exporter:SetStatus("Refreshing concentration...")
        C_Timer.After(0.05, function()
            if Exporter.panel and Exporter.panel:IsShown() then
                Exporter:SaveCurrentConcentration(false)
            end
        end)
    end)
    panel:Hide()

    if panel.TitleText then
        panel.TitleText:SetText("CraftPlan Exporter")
    else
        CreatePanelText(panel, "CraftPlan Exporter", "TOP", panel, "TOP", 0, -7)
    end

    CreatePanelText(panel, "CraftSim Recipe Scan", "TOPLEFT", panel, "TOPLEFT", 18, -36)
    CreatePanelButton(panel, "Scan all + variants", 18, -62, 220, function()
        Exporter:RunAllRecipeScanWithVariants()
    end)
    CreatePanelButton(panel, "Stats", 250, -62, 88, function()
        Exporter:Stats()
        Exporter:RefreshPanel()
    end)
    CreatePanelText(panel, "Scans current-character professions CraftSim has cached, e.g. Alchemy + Cooking.", "TOPLEFT", panel, "TOPLEFT", 18, -94, 440)

    CreatePanelText(panel, "Auctionator shopping list", "TOPLEFT", panel, "TOPLEFT", 18, -130)
    panel.shoppingListBox = CreatePanelMultilineInput(panel, 18, -154, 448, 100)
    CreatePanelButton(panel, "Create Auctionator list", 18, -266, 180, function()
        Exporter:CreateShoppingListFromPanel()
    end)
    CreatePanelButton(panel, "Clear paste box", 206, -266, 130, function()
        if panel.shoppingListBox then
            panel.shoppingListBox:SetText("")
            panel.shoppingListBox:ClearFocus()
        end
    end)

    panel.countText = CreatePanelText(panel, "", "BOTTOMLEFT", panel, "BOTTOMLEFT", 18, 38, 380)
    panel.statusText = CreatePanelText(panel, "", "BOTTOMLEFT", panel, "BOTTOMLEFT", 18, 18, 450)

    self.panel = panel
    self:RefreshPanel()
    return panel
end

function Exporter:TogglePanel()
    local panel = self:CreatePanel()
    if panel:IsShown() then
        panel:Hide()
    else
        panel:Show()
    end
end

local MINIMAP_BUTTON_RADIUS_OFFSET = 5
local MINIMAP_SHAPES = {
    ["ROUND"] = { true, true, true, true },
    ["SQUARE"] = { false, false, false, false },
    ["CORNER-TOPLEFT"] = { false, false, false, true },
    ["CORNER-TOPRIGHT"] = { false, false, true, false },
    ["CORNER-BOTTOMLEFT"] = { false, true, false, false },
    ["CORNER-BOTTOMRIGHT"] = { true, false, false, false },
    ["SIDE-LEFT"] = { false, true, false, true },
    ["SIDE-RIGHT"] = { true, false, true, false },
    ["SIDE-TOP"] = { false, false, true, true },
    ["SIDE-BOTTOM"] = { true, true, false, false },
    ["TRICORNER-TOPLEFT"] = { false, true, true, true },
    ["TRICORNER-TOPRIGHT"] = { true, false, true, true },
    ["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
    ["TRICORNER-BOTTOMRIGHT"] = { true, true, true, false },
}

local function MinimapAtan2(y, x)
    if math.atan2 then return math.atan2(y, x) end
    if x > 0 then return math.atan(y / x) end
    if x < 0 and y >= 0 then return math.atan(y / x) + math.pi end
    if x < 0 and y < 0 then return math.atan(y / x) - math.pi end
    if x == 0 and y > 0 then return math.pi / 2 end
    if x == 0 and y < 0 then return -math.pi / 2 end
    return 0
end

function Exporter:GetMinimapButtonOffset(angleDegrees)
    local angle = math.rad(angleDegrees or 225)
    local x, y = math.cos(angle), math.sin(angle)
    local quadrant = 1
    if x < 0 then quadrant = quadrant + 1 end
    if y > 0 then quadrant = quadrant + 2 end

    local minimapShape = GetMinimapShape and GetMinimapShape() or "ROUND"
    local shape = MINIMAP_SHAPES[minimapShape] or MINIMAP_SHAPES["ROUND"]
    local width = (Minimap:GetWidth() / 2) + MINIMAP_BUTTON_RADIUS_OFFSET
    local height = (Minimap:GetHeight() / 2) + MINIMAP_BUTTON_RADIUS_OFFSET

    if shape[quadrant] then
        return x * width, y * height
    end

    local diagonalWidth = math.sqrt(2 * width * width) - 10
    local diagonalHeight = math.sqrt(2 * height * height) - 10
    x = math.max(-width, math.min(x * diagonalWidth, width))
    y = math.max(-height, math.min(y * diagonalHeight, height))
    return x, y
end

function Exporter:UpdateMinimapButtonPosition()
    if not self.minimapButton then return end
    local db = EnsureDB()
    local x, y = self:GetMinimapButtonOffset(db.settings.minimapAngle or 225)
    self.minimapButton:ClearAllPoints()
    self.minimapButton:SetPoint("CENTER", Minimap, "CENTER", x, y)
end

function Exporter:CreateMinimapButton()
    if self.minimapButton or not Minimap then return end

    local button = CreateFrame("Button", "CraftPlanExporterMinimapButton", Minimap)
    button:SetSize(31, 31)
    button:SetFrameStrata("MEDIUM")
    if button.SetFixedFrameStrata then button:SetFixedFrameStrata(true) end
    button:SetFrameLevel(8)
    if button.SetFixedFrameLevel then button:SetFixedFrameLevel(true) end
    button:RegisterForClicks("LeftButtonUp", "RightButtonUp")
    button:RegisterForDrag("LeftButton")
    button:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

    button.background = button:CreateTexture(nil, "BACKGROUND")
    button.background:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
    button.background:SetSize(24, 24)
    button.background:SetPoint("CENTER", button, "CENTER")

    button.icon = button:CreateTexture(nil, "ARTWORK")
    button.icon:SetTexture("Interface\\AddOns\\CraftPlanExporter\\Media\\CraftingBuddyIcon")
    button.icon:SetSize(18, 18)
    button.icon:SetPoint("CENTER", button, "CENTER")

    button.border = button:CreateTexture(nil, "OVERLAY")
    button.border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
    button.border:SetSize(50, 50)
    button.border:SetPoint("TOPLEFT", button, "TOPLEFT")

    button:SetScript("OnClick", function(_, mouseButton)
        if mouseButton == "RightButton" then
            Exporter:Stats()
        else
            Exporter:TogglePanel()
        end
    end)
    button:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_LEFT")
        GameTooltip:AddLine("CraftPlan Exporter")
        GameTooltip:AddLine("Left click: open panel", 1, 1, 1)
        GameTooltip:AddLine("Right click: stats", 1, 1, 1)
        GameTooltip:AddLine("Drag: move icon", 1, 1, 1)
        GameTooltip:Show()
    end)
    button:SetScript("OnLeave", function()
        GameTooltip:Hide()
    end)
    button:SetScript("OnDragStart", function(self)
        self:SetScript("OnUpdate", function()
            local mx, my = Minimap:GetCenter()
            local px, py = GetCursorPosition()
            local scale = Minimap:GetEffectiveScale()
            px, py = px / scale, py / scale
            local angle = math.deg(MinimapAtan2(py - my, px - mx)) % 360
            EnsureDB().settings.minimapAngle = angle
            Exporter:UpdateMinimapButtonPosition()
        end)
    end)
    button:SetScript("OnDragStop", function(self)
        self:SetScript("OnUpdate", nil)
        Exporter:UpdateMinimapButtonPosition()
    end)

    self.minimapButton = button
    self:UpdateMinimapButtonPosition()
end

function Exporter:TryHookCraftSim()
    if self.hooked then return true end
    local CraftSim = self:GetCraftSim()
    if not CraftSim or not CraftSim.RECIPE_SCAN or not CraftSim.RECIPE_SCAN.UI then
        return false
    end

    if CraftSim.RECIPE_SCAN.UI.AddRecipe then
        hooksecurefunc(CraftSim.RECIPE_SCAN.UI, "AddRecipe", function(_, row, recipeData)
            Exporter:SaveRecipe(recipeData, "recipe-scan-live")
        end)
    end

    if CraftSim.RECIPE_SCAN.EndScan then
        hooksecurefunc(CraftSim.RECIPE_SCAN, "EndScan", function(_, row)
            Exporter:OnRecipeScanComplete(row, "recipe-scan-complete")
        end)
    end

    self.hooked = true
    Print("hooked CraftSim Recipe Scan.")
    return true
end

function Exporter:Help()
    Print("/cpe open - export the current CraftSim recipe")
    Print("/cpe scan - export selected Recipe Scan results")
    Print("/cpe variants [max] [all] [top=N] - test ingredient variants for the open recipe")
    Print("/cpe scanvariants [max] [all] [top=N] - test variants for selected Recipe Scan results")
    Print("/cpe runscan - run selected CraftSim Recipe Scan and save variants when done")
    Print("/cpe concentration - save current character concentration")
    Print("/cpe shopping - create an Auctionator list from the panel paste box")
    Print("/cpe panel - open the button panel")
    Print("/cpe stats - show exported record counts")
    Print("/cpe clear - clear exporter saved data")
end

function Exporter:HandleSlash(message)
    message = string.lower(strtrim(message or ""))
    local command, rest = string.match(message, "^(%S*)%s*(.-)$")
    command = command or ""
    rest = rest or ""

    if command == "open" then
        self:ExportOpenRecipe()
    elseif command == "scan" then
        self:ExportRecipeScanRow(nil, "recipe-scan-manual")
    elseif command == "variants" then
        self:ExportOpenRecipeVariants(rest)
    elseif command == "scanvariants" then
        self:ExportRecipeScanVariants(nil, rest)
    elseif command == "runscan" then
        self:RunSelectedRecipeScanWithVariants()
    elseif command == "shopping" then
        self:CreateShoppingListFromPanel()
    elseif command == "concentration" or command == "conc" then
        self:SaveCurrentConcentration(false)
    elseif command == "panel" or command == "show" or command == "" then
        self:TogglePanel()
    elseif command == "stats" then
        self:Stats()
    elseif command == "clear" then
        self:Clear()
    else
        self:Help()
    end
end

Exporter:SetScript("OnEvent", function(self, event, addonName)
    if event == "ADDON_LOADED" and addonName == ADDON_NAME then
        EnsureDB()
        self:CreateMinimapButton()
        SLASH_CRAFTPLANEXPORTER1 = "/cpe"
        SLASH_CRAFTPLANEXPORTER2 = "/craftplanexport"
        SlashCmdList.CRAFTPLANEXPORTER = function(message)
            Exporter:HandleSlash(message)
        end
    end

    if event == "PLAYER_LOGIN" or (event == "ADDON_LOADED" and addonName == "CraftSim") then
        if event == "PLAYER_LOGIN" then
            SavePlayerMeta()
        end
        Exporter:CreateMinimapButton()
        C_Timer.After(1, function()
            Exporter:TryHookCraftSim()
            Exporter:SaveCurrentConcentration(true)
        end)
    end

    if event == "TRADE_SKILL_SHOW" or event == "CURRENCY_DISPLAY_UPDATE" then
        C_Timer.After(0.2, function()
            Exporter:SaveCurrentConcentration(true)
        end)
    end
end)

Exporter:RegisterEvent("ADDON_LOADED")
Exporter:RegisterEvent("PLAYER_LOGIN")
Exporter:RegisterEvent("TRADE_SKILL_SHOW")
Exporter:RegisterEvent("CURRENCY_DISPLAY_UPDATE")
