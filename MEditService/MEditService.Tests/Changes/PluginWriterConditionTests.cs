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
