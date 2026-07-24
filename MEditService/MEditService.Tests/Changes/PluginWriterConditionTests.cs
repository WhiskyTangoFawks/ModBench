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
}
