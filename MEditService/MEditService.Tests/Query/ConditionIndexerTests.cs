using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

// Round-trips a record's conditions through the index (Fallout4ConditionCodec -> conditions /
// condition_parameters rows -> GetConditions), covering the storage layout and hydration that the
// codec's own unit tests don't. A COBJ is the fixture because its Conditions field is the slice-1
// target (ADR-0032).
public sealed class ConditionIndexerTests : IDisposable
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly FormKey _cobjFormKey;
    private readonly FormKey _questFormKey;
    private readonly PluginFixtureData _fixture;

    public ConditionIndexerTests()
    {
        FormKey cobjFk = default, questFk = default;
        _fixture = new PluginFixtureBuilder()
            .WithPlugin("CtdaTest.esp", mod =>
            {
                var quest = mod.Quests.AddNew("SomeQuest");
                questFk = quest.FormKey;

                var cobj = mod.ConstructibleObjects.AddNew("TestRecipe");
                cobjFk = cobj.FormKey;

                var data = new FunctionConditionData
                {
                    Function = Condition.Function.GetStageDone, // (Quest[Form], QuestStage[Number])
                    ParameterTwoNumber = 10,
                };
                data.ParameterOneRecord.SetTo(quest.FormKey);
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Flags = Condition.Flag.OR,
                    Data = data,
                });
            })
            .Build();
        _cobjFormKey = cobjFk;
        _questFormKey = questFk;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordRepository LoadedRepository()
    {
        var repo = new DuckDbRecordRepository(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("CtdaTest.esp"),
            Path.Combine(_fixture.DataFolder, "CtdaTest.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    [Fact]
    public void GetConditions_RoundTripsEnvelopeAndParameters()
    {
        using var repo = LoadedRepository();

        var owners = repo.GetConditions(_cobjFormKey.ToString(), "CtdaTest.esp");

        var owner = Assert.Single(owners);
        Assert.Equal("Conditions", owner.FieldPath);

        var condition = Assert.Single(owner.Conditions);
        Assert.Equal("GetStageDone", condition.Function);
        Assert.Equal(ConditionOperator.EqualTo, condition.Operator);
        Assert.True(condition.Or);
        Assert.Equal("Subject", condition.RunOnTarget);
        Assert.False(condition.UseGlobal);
        Assert.Equal(1.0f, condition.ComparisonFloat);

        Assert.Equal(2, condition.Parameters.Count);
        Assert.Equal(ConditionParamCategory.Form, condition.Parameters[0].Category);
        Assert.Equal(_questFormKey.ToString(), condition.Parameters[0].FormKey);
        Assert.Equal(ConditionParamCategory.Number, condition.Parameters[1].Category);
        Assert.Equal(10, condition.Parameters[1].Number);
    }

    [Fact]
    public void GetConditions_RecordWithoutConditions_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        Assert.Empty(repo.GetConditions(_questFormKey.ToString(), "CtdaTest.esp"));
    }
}
