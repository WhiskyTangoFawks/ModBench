using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Changes;

public class PluginWriterConditionTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // ---- IsReadOnly ----

    [Fact]
    public void IsReadOnly_ConditionScalarPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "cobj", @"CTDA\Conditions\0\Operator"));
    }

    [Fact]
    public void IsReadOnly_ConditionListPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "cobj", "Conditions"));
    }

    // #154: a record with more than one condition-owning field (Quest) must recognize each of them,
    // not just the single hardcoded "Conditions" name.
    [Theory]
    [InlineData("DialogConditions")]
    [InlineData("UnusedConditions")]
    public void IsReadOnly_ConditionListPath_OnNonConditionsFieldName_ReturnsFalse(string fieldPath)
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "qust", fieldPath));
    }

    // #182: a nested (per-array-item) condition path — its composed FieldPath segment contains an
    // enclosing-array index, e.g. "Effects[0].Conditions" — is now editable on the same terms as a
    // flat one, as long as it actually resolves against the record's schema type (walking into the
    // array element and checking it declares the named condition list). #181 rejected every such
    // path unconditionally; this is the regression test flipped the other way.
    [Fact]
    public void IsReadOnly_NestedConditionScalarPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "alch", @"CTDA\Effects[0].Conditions\0\Function"));
    }

    // #169/#182 AC#4: Quest.Aliases[i].Conditions is the explicit regression case for the
    // permissive abstract-element-type rule — IAQuestAliasGetter is a marker interface with zero
    // data properties, so only a check that falls back to concrete alias subtypes finds Conditions.
    [Fact]
    public void IsReadOnly_NestedConditionScalarPath_OnAbstractElementType_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "qust", @"CTDA\Aliases[0].Conditions\0\Function"));
    }

    // A nested path whose shape doesn't actually resolve against the record type (wrong nested
    // field name) fails closed at stage time — same as an out-of-range enclosing index fails
    // closed at save time (SaveAsync_ConditionNestedOutOfRangeIndex_AppearsInNotFound below); the
    // two are deliberately enforced at different points (#169's AC: existence/range at write).
    [Fact]
    public void IsReadOnly_NestedConditionScalarPath_WrongNestedFieldName_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "alch", @"CTDA\Effects[0].NotAConditionField\0\Function"));
    }

    // A syntactically malformed indexed segment (unbalanced bracket) is knowable from the string
    // alone with no instance needed, so — unlike an out-of-range index — it fails closed at stage.
    [Fact]
    public void IsReadOnly_NestedConditionScalarPath_MalformedBracket_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "alch", @"CTDA\Effects[0.Conditions\0\Function"));
    }

    // #183: a nested restage stages at the bare composed path (no CTDA prefix, no per-condition
    // index) — the whole-list-restage analogue of the flat "Conditions" bare-path test above
    // (IsReadOnly_ConditionListPath_ReturnsFalse), extended to an indexed nested path.
    [Fact]
    public void IsReadOnly_NestedConditionListPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "alch", "Effects[0].Conditions"));
    }

    // Same "fails closed at stage" rule as the CTDA-prefixed nested case: a nested field name that
    // doesn't actually resolve against the record's schema type is read-only, not silently accepted.
    [Fact]
    public void IsReadOnly_NestedConditionListPath_WrongNestedFieldName_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "alch", "Effects[0].NotAConditionField"));
    }

    [Fact]
    public void IsReadOnly_NestedConditionListPath_MalformedBracket_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "alch", "Effects[0.Conditions"));
    }

    // ---- Two levels of array-item nesting (#184): Perk.Effects[i].Conditions[j].Conditions —
    // the case #154 was originally descoped from. Both the CTDA-prefixed scalar form and the bare
    // whole-list-restage form resolve through the same generalized N-hop walk the one-level cases
    // above use, just with one more segment.

    [Fact]
    public void IsReadOnly_TwoLevelNestedConditionScalarPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "perk", @"CTDA\Effects[0].Conditions[0].Conditions\0\Function"));
    }

    [Fact]
    public void IsReadOnly_TwoLevelNestedConditionListPath_ReturnsFalse()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.False(writer.IsReadOnly(GameRelease.Fallout4, "perk", "Effects[0].Conditions[0].Conditions"));
    }

    // A two-level path whose terminal field name doesn't resolve fails closed exactly like the
    // one-level case.
    [Fact]
    public void IsReadOnly_TwoLevelNestedConditionListPath_WrongTerminalFieldName_ReturnsTrue()
    {
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);
        Assert.True(writer.IsReadOnly(GameRelease.Fallout4, "perk", "Effects[0].Conditions[0].NotAConditionField"));
    }

    // ---- Helpers ----

    private static (string pluginPath, FormKey cobjFk, PluginFixtureData data) BuildFixture(string prefix)
    {
        FormKey cobjFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "ConditionWrite.esp"), cobjFk, fixture);
    }

    private static PendingChange MakeConditionChange(FormKey formKey, string fieldPath, string json) =>
        new(Guid.NewGuid(), formKey.ToString(), "ConditionWrite.esp", fieldPath, "cobj",
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static PendingChange MakeConditionChange(FormKey formKey, string recordType, string fieldPath, string json) =>
        new(Guid.NewGuid(), formKey.ToString(), "ConditionWrite.esp", fieldPath, recordType,
            JsonDocument.Parse("null").RootElement, J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static IConstructibleObjectGetter ReloadCobj(string pluginPath, FormKey cobjKey)
    {
        var modPath = new ModPath(ModKey.FromFileName("ConditionWrite.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        return mod.ConstructibleObjects.First(c => c.FormKey == cobjKey);
    }

    // ---- Operator edit ----

    [Fact]
    public async Task SaveAsync_ConditionOperatorEdit_WritesNewOperator()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-operator");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\Operator", "\"GreaterThan\"")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\Operator", result.Applied);
        Assert.Empty(result.NotFound);

        var cond = ReloadCobj(path, cobjFk).Conditions[0];
        Assert.Equal(CompareOperator.GreaterThan, cond.CompareOperator);
    }

    // ---- Function edit resets parameters ----

    [Fact]
    public async Task SaveAsync_ConditionFunctionEdit_ChangesFunctionAndResetsParameters()
    {
        FormKey cobjFk = default;
        var quest = FormKey.Factory("001234:ConditionWrite.esp");
        using var fixture = new PluginFixtureBuilder("cond-function")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                var data = new FunctionConditionData { Function = Condition.Function.GetStageDone };
                data.ParameterOneRecord.SetTo(quest);
                cobj.Conditions.Add(new ConditionFloat { Data = data });
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\Function", "\"GetGraphVariableFloat\"")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\Function", result.Applied);

        var data = (IFunctionConditionDataGetter)ReloadCobj(path, cobjFk).Conditions[0].Data;
        Assert.Equal(Condition.Function.GetGraphVariableFloat, data.Function);
        Assert.True(data.ParameterOneRecord.FormKey.IsNull);
    }

    // ---- Parameter edit ----

    [Fact]
    public async Task SaveAsync_ConditionNumberParameterEdit_WritesNumberSlot()
    {
        FormKey cobjFk = default;
        using var fixture = new PluginFixtureBuilder("cond-numparam")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    Data = new FunctionConditionData { Function = Condition.Function.GetStageDone },
                });
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\Parameter\1", "7")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\Parameter\1", result.Applied);
        var data = (IFunctionConditionDataGetter)ReloadCobj(path, cobjFk).Conditions[0].Data;
        Assert.Equal(7, data.ParameterTwoNumber);
    }

    // ---- RunOn edit ----

    [Fact]
    public async Task SaveAsync_ConditionRunOnEdit_WritesRunOnTypeAndReference()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-runon");
        using var _ = fixture;
        var reference = FormKey.Factory("00dcba:ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var json = $$"""{"target":"Reference","reference":"{{reference}}"}""";
        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\RunOn", json)], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\RunOn", result.Applied);
        var data = ReloadCobj(path, cobjFk).Conditions[0].Data;
        Assert.Equal(Condition.RunOnType.Reference, data.RunOnType);
        Assert.Equal(reference, data.Reference.FormKey);
    }

    // ---- Comparison edit ----

    [Fact]
    public async Task SaveAsync_ConditionComparisonEdit_WritesFloatValue()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-comparison");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\Comparison", "3.5")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\Comparison", result.Applied);
        var cond = Assert.IsAssignableFrom<IConditionFloatGetter>(ReloadCobj(path, cobjFk).Conditions[0]);
        Assert.Equal(3.5f, cond.ComparisonValue);
    }

    // ---- UseGlobal toggle ----

    [Fact]
    public async Task SaveAsync_ConditionUseGlobalEdit_SwitchesToGlobalConditionType()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-useglobal");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\UseGlobal", "true")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\0\UseGlobal", result.Applied);
        Assert.IsAssignableFrom<IConditionGlobalGetter>(ReloadCobj(path, cobjFk).Conditions[0]);
    }

    // ---- Unknown condition index -> NotFound ----

    [Fact]
    public async Task SaveAsync_ConditionUnknownIndex_AppearsInNotFound()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-notfound");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\9\Operator", "\"GreaterThan\"")], GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Conditions\9\Operator", result.NotFound);
        Assert.Empty(result.Applied);
    }

    // ---- Whole-list restage (#153): add/remove/move stage the entire list at the bare owning
    // field path, per ADR-0019 / EditOrchestrator's condition-owner FieldEdit routing. ----

    [Fact]
    public async Task SaveAsync_ConditionListRestage_ReplacesEntireList()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-list-restage");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newList = """
            [
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 5.0, "comparisonGlobal": null, "parameters": [] },
              { "function": "GetDead", "operator": "NotEqualTo", "or": true, "runOnTarget": "Target",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 0.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;

        var result = await writer.SaveAsync(path, [MakeConditionChange(cobjFk, "Conditions", newList)], GameRelease.Fallout4);

        Assert.Contains("Conditions", result.Applied);
        var conditions = ReloadCobj(path, cobjFk).Conditions;
        Assert.Equal(2, conditions.Count);
        Assert.Equal(CompareOperator.EqualTo, conditions[0].CompareOperator);
        Assert.Equal(CompareOperator.NotEqualTo, conditions[1].CompareOperator);
        Assert.Equal(Condition.Flag.OR, conditions[1].Flags);
    }

    // Q3 ordering guarantee: an add-then-immediately-edit-the-new-condition flow (#153 AC1, "the
    // new condition is immediately editable via #152's field editors") leaves a per-field CTDA\
    // edit staged on top of a list-restage in the same save. The per-field edit must win — it's
    // staged after the restage and its index only exists once the restage has run — regardless of
    // which order the two pending changes happen to enumerate in.
    [Fact]
    public async Task SaveAsync_ConditionListRestagePlusFieldEditOnNewCondition_FieldEditWinsOverRestage()
    {
        var (path, cobjFk, fixture) = BuildFixture("cond-list-restage-order");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newList = """
            [
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 1.0, "comparisonGlobal": null, "parameters": [] },
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 0.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;

        // Deliberately ordered per-field-edit-before-restage in the input: proves the writer
        // reorders rather than relying on incidental enumeration order.
        var changes = new[]
        {
            MakeConditionChange(cobjFk, @"CTDA\Conditions\1\Function", "\"GetDead\""),
            MakeConditionChange(cobjFk, "Conditions", newList),
        };

        var result = await writer.SaveAsync(path, changes, GameRelease.Fallout4);

        Assert.Contains("Conditions", result.Applied);
        Assert.Contains(@"CTDA\Conditions\1\Function", result.Applied);

        var conditions = ReloadCobj(path, cobjFk).Conditions;
        Assert.Equal(2, conditions.Count);
        var data = (IFunctionConditionDataGetter)conditions[1].Data;
        Assert.Equal(Condition.Function.GetDead, data.Function);
    }

    // ---- Multiple condition lists on one record (#154) ----

    // Quest has two flat, top-level condition-carrying fields (DialogConditions, UnusedConditions)
    // — restaging one must never touch the other, proving the wire-path/apply-dispatch keying by
    // field name (not a single hardcoded "Conditions") actually isolates them end to end.
    [Fact]
    public async Task SaveAsync_ConditionListRestageOnOneField_SiblingFieldOnSameRecordUntouched()
    {
        FormKey questFk = default;
        using var fixture = new PluginFixtureBuilder("cond-multi-list")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var quest = mod.Quests.AddNew("MultiListQuest");
                questFk = quest.FormKey;
                quest.DialogConditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                quest.UnusedConditions = [
                    new ConditionFloat
                    {
                        CompareOperator = CompareOperator.LessThan,
                        Data = new FunctionConditionData { Function = Condition.Function.GetDead },
                    },
                ];
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newDialogList = """
            [
              { "function": "GetIsID", "operator": "NotEqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 9.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;
        var change = new PendingChange(Guid.NewGuid(), questFk.ToString(), "ConditionWrite.esp",
            "DialogConditions", "qust", JsonDocument.Parse("null").RootElement, J(newDialogList),
            "user", null, DateTime.UtcNow, "field_edit", null);

        var result = await writer.SaveAsync(path, [change], GameRelease.Fallout4);

        Assert.Contains("DialogConditions", result.Applied);
        var modPath = new ModPath(ModKey.FromFileName("ConditionWrite.esp"), path);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        var reloaded = mod.Quests.First(q => q.FormKey == questFk);

        Assert.Equal(CompareOperator.NotEqualTo, Assert.Single(reloaded.DialogConditions).CompareOperator);

        // UnusedConditions was never staged — must remain exactly as it was.
        var unusedCondition = Assert.Single(reloaded.UnusedConditions!);
        Assert.Equal(CompareOperator.LessThan, unusedCondition.CompareOperator);
        Assert.Equal(Condition.Function.GetDead, ((IFunctionConditionDataGetter)unusedCondition.Data).Function);
    }

    // ---- Sibling conditions untouched ----

    [Fact]
    public async Task SaveAsync_ConditionEdit_SiblingConditionUntouched()
    {
        FormKey cobjFk = default;
        using var fixture = new PluginFixtureBuilder("cond-sibling")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjFk = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.LessThan,
                    Data = new FunctionConditionData { Function = Condition.Function.GetDead },
                });
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        await writer.SaveAsync(path,
            [MakeConditionChange(cobjFk, @"CTDA\Conditions\0\Operator", "\"GreaterThan\"")], GameRelease.Fallout4);

        var conditions = ReloadCobj(path, cobjFk).Conditions;
        Assert.Equal(2, conditions.Count);
        Assert.Equal(CompareOperator.GreaterThan, conditions[0].CompareOperator);
        Assert.Equal(CompareOperator.LessThan, conditions[1].CompareOperator);
    }

    // ---- Nested (per-array-item) condition paths (#182) ----
    // One round-trip per sub-field kind, at Ingestible.Effects[0].Conditions — the same fixture
    // shape #181's discovery tests use. Mirrors the flat-group tests above one for one, proving
    // scalar editing works on the same terms at an indexed path.

    private static (string pluginPath, FormKey ingestibleFk, PluginFixtureData data) BuildNestedFixture(string prefix)
    {
        FormKey ingestibleFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect = new Effect { Data = new EffectData() };
                effect.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                ingestible.Effects.Add(effect);
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "ConditionWrite.esp"), ingestibleFk, fixture);
    }

    private static IIngestibleGetter ReloadIngestible(string pluginPath, FormKey ingestibleKey)
    {
        var modPath = new ModPath(ModKey.FromFileName("ConditionWrite.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        return mod.Ingestibles.First(i => i.FormKey == ingestibleKey);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionOperatorEdit_WritesNewOperator()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-operator");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\Operator", "\"GreaterThan\"")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\Operator", result.Applied);
        var cond = ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0];
        Assert.Equal(CompareOperator.GreaterThan, cond.CompareOperator);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionFunctionEdit_ChangesFunctionAndResetsParameters()
    {
        FormKey ingestibleFk = default;
        var quest = FormKey.Factory("001234:ConditionWrite.esp");
        using var fixture = new PluginFixtureBuilder("cond-nested-function")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect = new Effect { Data = new EffectData() };
                var data = new FunctionConditionData { Function = Condition.Function.GetStageDone };
                data.ParameterOneRecord.SetTo(quest);
                effect.Conditions.Add(new ConditionFloat { Data = data });
                ingestible.Effects.Add(effect);
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\Function", "\"GetGraphVariableFloat\"")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\Function", result.Applied);
        var data = (IFunctionConditionDataGetter)ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0].Data;
        Assert.Equal(Condition.Function.GetGraphVariableFloat, data.Function);
        Assert.True(data.ParameterOneRecord.FormKey.IsNull);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionNumberParameterEdit_WritesNumberSlot()
    {
        FormKey ingestibleFk = default;
        using var fixture = new PluginFixtureBuilder("cond-nested-numparam")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var ingestible = mod.Ingestibles.AddNew("Chem");
                ingestibleFk = ingestible.FormKey;
                var effect = new Effect { Data = new EffectData() };
                effect.Conditions.Add(new ConditionFloat
                {
                    Data = new FunctionConditionData { Function = Condition.Function.GetStageDone },
                });
                ingestible.Effects.Add(effect);
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\Parameter\1", "7")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\Parameter\1", result.Applied);
        var data = (IFunctionConditionDataGetter)ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0].Data;
        Assert.Equal(7, data.ParameterTwoNumber);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionRunOnEdit_WritesRunOnTypeAndReference()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-runon");
        using var _ = fixture;
        var reference = FormKey.Factory("00dcba:ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var json = $$"""{"target":"Reference","reference":"{{reference}}"}""";
        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\RunOn", json)],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\RunOn", result.Applied);
        var data = ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0].Data;
        Assert.Equal(Condition.RunOnType.Reference, data.RunOnType);
        Assert.Equal(reference, data.Reference.FormKey);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionComparisonEdit_WritesFloatValue()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-comparison");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\Comparison", "3.5")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\Comparison", result.Applied);
        var cond = Assert.IsAssignableFrom<IConditionFloatGetter>(ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0]);
        Assert.Equal(3.5f, cond.ComparisonValue);
    }

    [Fact]
    public async Task SaveAsync_NestedConditionUseGlobalEdit_SwitchesToGlobalConditionType()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-useglobal");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\UseGlobal", "true")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions\0\UseGlobal", result.Applied);
        Assert.IsAssignableFrom<IConditionGlobalGetter>(ReloadIngestible(path, ingestibleFk).Effects[0].Conditions[0]);
    }

    // #169's AC: an out-of-range enclosing index can only be caught with a live instance, so it's
    // enforced here (at save) rather than at stage. Staged alongside one valid nested edit in the
    // same save to prove the failure never turns into a partial write — the valid edit still lands
    // and the out-of-range one is cleanly NotFound, not a thrown exception or a corrupted file.
    [Fact]
    public async Task SaveAsync_NestedConditionOutOfRangeEnclosingIndex_AppearsInNotFoundWithoutPartialWrite()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-outofrange");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var changes = new[]
        {
            MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[0].Conditions\0\Operator", "\"GreaterThan\""),
            MakeConditionChange(ingestibleFk, "alch", @"CTDA\Effects[9].Conditions\0\Operator", "\"GreaterThan\""),
        };

        var result = await writer.SaveAsync(path, changes, GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[9].Conditions\0\Operator", result.NotFound);
        Assert.Contains(@"CTDA\Effects[0].Conditions\0\Operator", result.Applied);

        var reloaded = ReloadIngestible(path, ingestibleFk);
        Assert.Single(reloaded.Effects);
        Assert.Equal(CompareOperator.GreaterThan, reloaded.Effects[0].Conditions[0].CompareOperator);
    }

    // #169/#182 AC#4: Quest.Aliases[i].Conditions — the write-side companion to the abstract-
    // element-type IsReadOnly regression test above. AQuestAlias is a bare abstract setter base
    // (no Conditions of its own); QuestReferenceAlias is a real concrete alias type that declares
    // one, resolved here purely via the runtime instance's own concrete type (no fallback needed
    // at write time — only the Type-only stage-time shape check needs the abstract-subtype scan).
    [Fact]
    public async Task SaveAsync_NestedConditionOnQuestAlias_WritesNewOperator()
    {
        FormKey questFk = default;
        using var fixture = new PluginFixtureBuilder("cond-nested-alias")
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var quest = mod.Quests.AddNew("AliasQuest");
                questFk = quest.FormKey;
                var alias = new QuestReferenceAlias();
                alias.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                quest.Aliases = [alias];
            })
            .Build();
        var path = Path.Combine(fixture.DataFolder, "ConditionWrite.esp");
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(questFk, "qust", @"CTDA\Aliases[0].Conditions\0\Operator", "\"GreaterThan\"")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Aliases[0].Conditions\0\Operator", result.Applied);
        var modPath = new ModPath(ModKey.FromFileName("ConditionWrite.esp"), path);
        var reloaded = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4)
            .Quests.First(q => q.FormKey == questFk);
        var alias = Assert.IsAssignableFrom<IQuestReferenceAliasGetter>(reloaded.Aliases![0]);
        Assert.Equal(CompareOperator.GreaterThan, alias.Conditions[0].CompareOperator);
    }

    // ---- Nested whole-list restage (#183): add/remove/move stage the entire nested list at its
    // own composed indexed field path ("Effects[0].Conditions"), the same bare-path mechanism the
    // flat SaveAsync_ConditionListRestage_ReplacesEntireList test proves for a top-level field. ----

    [Fact]
    public async Task SaveAsync_NestedConditionListRestage_ReplacesEntireList()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-list-restage");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newList = """
            [
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 5.0, "comparisonGlobal": null, "parameters": [] },
              { "function": "GetDead", "operator": "NotEqualTo", "or": true, "runOnTarget": "Target",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 0.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", "Effects[0].Conditions", newList)], GameRelease.Fallout4);

        Assert.Contains("Effects[0].Conditions", result.Applied);
        var conditions = ReloadIngestible(path, ingestibleFk).Effects[0].Conditions;
        Assert.Equal(2, conditions.Count);
        Assert.Equal(CompareOperator.EqualTo, conditions[0].CompareOperator);
        Assert.Equal(CompareOperator.NotEqualTo, conditions[1].CompareOperator);
        Assert.Equal(Condition.Flag.OR, conditions[1].Flags);
    }

    // #169's AC: an out-of-range enclosing index can only be caught with a live instance — the
    // whole-list-restage analogue of SaveAsync_NestedConditionOutOfRangeEnclosingIndex... above.
    [Fact]
    public async Task SaveAsync_NestedConditionListRestageOutOfRangeIndex_AppearsInNotFoundWithoutPartialWrite()
    {
        var (path, ingestibleFk, fixture) = BuildNestedFixture("cond-nested-list-restage-oor");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newList = """
            [
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 5.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(ingestibleFk, "alch", "Effects[9].Conditions", newList)], GameRelease.Fallout4);

        Assert.Contains("Effects[9].Conditions", result.NotFound);
        Assert.Empty(result.Applied);

        var reloaded = ReloadIngestible(path, ingestibleFk);
        Assert.Single(reloaded.Effects);
        Assert.Single(reloaded.Effects[0].Conditions);
        Assert.Equal(CompareOperator.EqualTo, reloaded.Effects[0].Conditions[0].CompareOperator);
    }

    // ---- Two levels of array-item nesting, write-back (#184): Perk.Effects[i].Conditions[j].
    // Conditions. Same round-trip shape as the one-level Ingestible fixtures above, one segment
    // deeper — proving ResolveNestedConditionList's N-hop walk actually reaches and mutates the
    // real nested list, not just resolves its shape.

    private static (string pluginPath, FormKey perkFk, PluginFixtureData data) BuildTwoLevelNestedFixture(string prefix)
    {
        FormKey perkFk = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin("ConditionWrite.esp", mod =>
            {
                var perk = mod.Perks.AddNew("TestPerk");
                perkFk = perk.FormKey;
                var effect = new PerkQuestEffect();
                var perkCondition = new PerkCondition();
                perkCondition.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                effect.Conditions.Add(perkCondition);
                perk.Effects.Add(effect);
            })
            .Build();
        return (Path.Combine(fixture.DataFolder, "ConditionWrite.esp"), perkFk, fixture);
    }

    private static IPerkGetter ReloadPerk(string pluginPath, FormKey perkKey)
    {
        var modPath = new ModPath(ModKey.FromFileName("ConditionWrite.esp"), pluginPath);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        return mod.Perks.First(p => p.FormKey == perkKey);
    }

    [Fact]
    public async Task SaveAsync_TwoLevelNestedConditionOperatorEdit_WritesNewOperator()
    {
        var (path, perkFk, fixture) = BuildTwoLevelNestedFixture("cond-2level-operator");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(perkFk, "perk", @"CTDA\Effects[0].Conditions[0].Conditions\0\Operator", "\"GreaterThan\"")],
            GameRelease.Fallout4);

        Assert.Contains(@"CTDA\Effects[0].Conditions[0].Conditions\0\Operator", result.Applied);
        var cond = ReloadPerk(path, perkFk).Effects[0].Conditions[0].Conditions[0];
        Assert.Equal(CompareOperator.GreaterThan, cond.CompareOperator);
    }

    [Fact]
    public async Task SaveAsync_TwoLevelNestedConditionListRestage_ReplacesEntireList()
    {
        var (path, perkFk, fixture) = BuildTwoLevelNestedFixture("cond-2level-list-restage");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var newList = """
            [
              { "function": "GetIsID", "operator": "EqualTo", "or": false, "runOnTarget": "Subject",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 5.0, "comparisonGlobal": null, "parameters": [] },
              { "function": "GetDead", "operator": "NotEqualTo", "or": true, "runOnTarget": "Target",
                "runOnReference": null, "useGlobal": false, "comparisonFloat": 0.0, "comparisonGlobal": null, "parameters": [] }
            ]
            """;

        var result = await writer.SaveAsync(path,
            [MakeConditionChange(perkFk, "perk", "Effects[0].Conditions[0].Conditions", newList)], GameRelease.Fallout4);

        Assert.Contains("Effects[0].Conditions[0].Conditions", result.Applied);
        var conditions = ReloadPerk(path, perkFk).Effects[0].Conditions[0].Conditions;
        Assert.Equal(2, conditions.Count);
        Assert.Equal(CompareOperator.EqualTo, conditions[0].CompareOperator);
        Assert.Equal(CompareOperator.NotEqualTo, conditions[1].CompareOperator);
    }

    // #169's AC generalized to two levels: an out-of-range index at *either* hop (outer Effects, or
    // the middle PerkCondition list) can only be caught with a live instance, so both fail closed
    // at save — never a partial write — the same way a one-level out-of-range enclosing index does.
    [Theory]
    [InlineData(@"CTDA\Effects[9].Conditions[0].Conditions\0\Operator")]
    [InlineData(@"CTDA\Effects[0].Conditions[9].Conditions\0\Operator")]
    public async Task SaveAsync_TwoLevelNestedConditionOutOfRangeAtEitherHop_AppearsInNotFoundWithoutPartialWrite(
        string badPath)
    {
        var (path, perkFk, fixture) = BuildTwoLevelNestedFixture("cond-2level-outofrange");
        using var _ = fixture;
        var writer = new PluginWriter(Reflector, NullLogger<PluginWriter>.Instance);

        var changes = new[]
        {
            MakeConditionChange(perkFk, "perk", @"CTDA\Effects[0].Conditions[0].Conditions\0\Operator", "\"GreaterThan\""),
            MakeConditionChange(perkFk, "perk", badPath, "\"GreaterThan\""),
        };

        var result = await writer.SaveAsync(path, changes, GameRelease.Fallout4);

        Assert.Contains(badPath, result.NotFound);
        Assert.Contains(@"CTDA\Effects[0].Conditions[0].Conditions\0\Operator", result.Applied);

        var reloaded = ReloadPerk(path, perkFk);
        Assert.Single(reloaded.Effects);
        Assert.Equal(CompareOperator.GreaterThan, reloaded.Effects[0].Conditions[0].Conditions[0].CompareOperator);
    }
}
