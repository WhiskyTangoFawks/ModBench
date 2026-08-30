using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

// Round-trips a record's conditions through the index (Index -> the record's own document ->
// GetConditions's reconstitute-and-re-Extract, #420 — previously through the now-deleted
// conditions/condition_parameters relational rows), covering the ingest/hydration wiring the
// codec's own unit tests don't. A COBJ is the fixture because its Conditions field is the slice-1
// target (ADR-0032).
//
// #421: GetConditions is rejected from IRecordReads/IRecordIndex outright — condition
// reconstitution moved to Queries/RecordDocumentCodecs, operating on RecordDocument.Body. This
// suite's own reader-level coverage is preserved by calling that relocated logic through the local
// GetConditions helper below (same fixtures, same assertions) rather than the deleted repository
// method directly.
public sealed class ConditionIndexerTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly IConditionCodec? Codec = ConditionCodecRegistry.For(GameRelease.Fallout4.ToCategory());

    private static IReadOnlyList<ConditionOwner> GetConditions(IRecordReads repo, string formKey, string plugin, string origin)
    {
        var document = repo.GetDocument(formKey, new PluginKey(plugin, origin));
        return document == null ? [] : RecordDocumentCodecs.GetConditions(document, GameRelease.Fallout4, Codec);
    }

    private readonly FormKey _cobjFormKey;
    private readonly FormKey _questFormKey;
    private readonly FormKey _multiListQuestFormKey;
    private readonly FormKey _sexCobjFormKey;
    private readonly FormKey _runOnRefCobjFormKey;
    private readonly FormKey _referenceTargetFormKey;
    private readonly FormKey _globalCobjFormKey;
    private readonly FormKey _globalFormKey;
    private readonly PluginFixtureData _fixture;

    public ConditionIndexerTests()
    {
        FormKey cobjFk = default, questFk = default, multiListQuestFk = default, sexCobjFk = default;
        FormKey runOnRefCobjFk = default, referenceTargetFk = default, globalCobjFk = default, globalFk = default;
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

                // #166: a Run-On target of Reference and a Use-Global comparison are the other two
                // FormKey-bearing condition slots (alongside a Form parameter, covered by `cobj`
                // above) that must feed form_references — each gets its own record fixture below so
                // GetReferences can prove the referencing record surfaces in Referenced-By.
                var referenceTarget = mod.Npcs.AddNew("ReferenceTarget");
                referenceTargetFk = referenceTarget.FormKey;

                var runOnRefCobj = mod.ConstructibleObjects.AddNew("RunOnRefRecipe");
                runOnRefCobjFk = runOnRefCobj.FormKey;
                var runOnData = new FunctionConditionData
                {
                    Function = Condition.Function.GetIsID,
                    RunOnType = Condition.RunOnType.Reference,
                };
                runOnData.Reference.SetTo(referenceTarget.FormKey);
                runOnRefCobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = runOnData,
                });

                var global = mod.Globals.AddNewFloat("SomeGlobal");
                globalFk = global.FormKey;

                var globalCobj = mod.ConstructibleObjects.AddNew("GlobalRecipe");
                globalCobjFk = globalCobj.FormKey;
                var globalCondition = new ConditionGlobal
                {
                    CompareOperator = CompareOperator.EqualTo,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                };
                globalCondition.ComparisonValue.SetTo(global.FormKey);
                globalCobj.Conditions.Add(globalCondition);

                // #154: Quest has two flat, top-level condition-carrying fields
                // (DialogConditions, UnusedConditions) — the multi-owner fixture. Both are
                // populated here so GetConditions must key them independently by field path.
                var multiListQuest = mod.Quests.AddNew("MultiConditionListQuest");
                multiListQuestFk = multiListQuest.FormKey;
                multiListQuest.DialogConditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
                multiListQuest.UnusedConditions = [
                    new ConditionFloat
                    {
                        CompareOperator = CompareOperator.GreaterThan,
                        ComparisonValue = 2.0f,
                        Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                    },
                ];

                // #165: a Number-category parameter with a known enum table (Sex) — the read path
                // (GetConditions) must attach the decoded member name alongside the raw value.
                var sexCobj = mod.ConstructibleObjects.AddNew("SexTestRecipe");
                sexCobjFk = sexCobj.FormKey;
                sexCobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = new FunctionConditionData
                    {
                        Function = Condition.Function.GetIsSex, // (Sex, None, None)
                        ParameterOneNumber = 0, // Male
                    },
                });
            })
            .Build();
        _cobjFormKey = cobjFk;
        _questFormKey = questFk;
        _multiListQuestFormKey = multiListQuestFk;
        _sexCobjFormKey = sexCobjFk;
        _runOnRefCobjFormKey = runOnRefCobjFk;
        _referenceTargetFormKey = referenceTargetFk;
        _globalCobjFormKey = globalCobjFk;
        _globalFormKey = globalFk;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedRepository()
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("CtdaTest.esp"),
            Path.Combine(_fixture.DataFolder, "CtdaTest.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();
        return repo;
    }

    // #272 / ADR-0036: two origins loading the same physical file — conditions/condition_parameters
    // had no origin column at all before this ticket; GetConditions's read side must not collide
    // once they do.
    [Fact]
    public void GetConditions_SameFilenameDifferentOrigin_ScopesToOrigin()
    {
        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("CtdaTest.esp"),
            Path.Combine(_fixture.DataFolder, "CtdaTest.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);

        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "ModA"));
        repo.Index(mod, Registration.Participating(1), new PluginKey(mod.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        Assert.NotEmpty(GetConditions(repo, _cobjFormKey.ToString(), "CtdaTest.esp", "ModA"));
        Assert.NotEmpty(GetConditions(repo, _cobjFormKey.ToString(), "CtdaTest.esp", "ModB"));
        Assert.Empty(GetConditions(repo, _cobjFormKey.ToString(), "CtdaTest.esp", "ModC"));
    }

    [Fact]
    public void GetConditions_RoundTripsEnvelopeAndParameters()
    {
        using var repo = LoadedRepository();

        var owners = GetConditions(repo, _cobjFormKey.ToString(), "CtdaTest.esp", origin: "Data");

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
        Assert.Empty(GetConditions(repo, _questFormKey.ToString(), "CtdaTest.esp", origin: "Data"));
    }

    // Invariant 7 (missing data reads as empty, never a throw): distinct from the case above, where
    // a `records` row exists but carries no conditions. Here no row exists at all — the synthetic
    // header FormKey is the real production example (D8: a ModHeader is never an IMajorRecordGetter,
    // so it never had a document to begin with) — exercising ReadRecordBody's "no row" branch.
    [Fact]
    public void GetConditions_ReturnsEmpty_WhenRecordDoesNotExist()
    {
        using var repo = LoadedRepository();

        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName("CtdaTest.esp"));
        Assert.Empty(GetConditions(repo, headerFormKey, "CtdaTest.esp", origin: "Data"));
    }

    // #154: a record with more than one condition-carrying field (Quest.DialogConditions and
    // Quest.UnusedConditions are both flat top-level Condition lists) must surface one owner per
    // field, each keyed by its own FieldPath, never merged or collided.
    [Fact]
    public void GetConditions_RecordWithMultipleConditionLists_ReturnsOneOwnerPerFieldPath()
    {
        using var repo = LoadedRepository();

        var owners = GetConditions(repo, _multiListQuestFormKey.ToString(), "CtdaTest.esp", origin: "Data");

        Assert.Equal(2, owners.Count);
        var dialog = owners.Single(o => o.FieldPath == "DialogConditions");
        var unused = owners.Single(o => o.FieldPath == "UnusedConditions");

        var dialogCondition = Assert.Single(dialog.Conditions);
        Assert.Equal(ConditionOperator.EqualTo, dialogCondition.Operator);
        Assert.Equal(1.0f, dialogCondition.ComparisonFloat);

        var unusedCondition = Assert.Single(unused.Conditions);
        Assert.Equal(ConditionOperator.GreaterThan, unusedCondition.Operator);
        Assert.Equal(2.0f, unusedCondition.ComparisonFloat);
    }

    // #165: DecodeParamValue is wired through the read path — GetConditions attaches the decoded
    // enum member name to a Number-category parameter whose TypeName has a known static table,
    // alongside the raw value it was decoded from (never replacing it in storage).
    [Fact]
    public void GetConditions_NumberParameterWithKnownEnumType_AttachesDecodedValue()
    {
        using var repo = LoadedRepository();

        var owner = Assert.Single(GetConditions(repo, _sexCobjFormKey.ToString(), "CtdaTest.esp", origin: "Data"));
        var condition = Assert.Single(owner.Conditions);
        var param = Assert.Single(condition.Parameters);

        Assert.Equal(ConditionParamCategory.Number, param.Category);
        Assert.Equal("Sex", param.TypeName);
        Assert.Equal(0, param.Number);
        Assert.Equal("Male", param.DecodedValue);
    }

    // --- form_references (#166): a condition's FormKey-bearing slots feed the same shared refs
    // list CollectVmadRefs already feeds (#420), so a record referenced only by a condition
    // surfaces in Referenced-By. Mirrors VmadIndexerTests.VmadObjectProperty_RegistersFormReference. ---

    [Fact]
    public void FormParameter_RegistersFormReference()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT field_path, target_form_key
            FROM form_references
            WHERE source_form_key = $1 AND field_path LIKE 'CTDA%'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _cobjFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a form_references row for the condition's Form parameter");
        Assert.Contains("CTDA", reader.GetString(0));
        Assert.Equal(_questFormKey.ToString(), reader.GetString(1));
    }

    [Fact]
    public void RunOnReference_RegistersFormReference()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT field_path, target_form_key
            FROM form_references
            WHERE source_form_key = $1 AND field_path LIKE 'CTDA%'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _runOnRefCobjFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a form_references row for the condition's Run-On reference");
        Assert.Equal(_referenceTargetFormKey.ToString(), reader.GetString(1));
    }

    [Fact]
    public void ComparisonGlobal_RegistersFormReference()
    {
        using var repo = LoadedRepository();
        var conn = repo.Connection;

        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT field_path, target_form_key
            FROM form_references
            WHERE source_form_key = $1 AND field_path LIKE 'CTDA%'
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = _globalCobjFormKey.ToString() });
        using var reader = cmd.ExecuteReader();

        Assert.True(reader.Read(), "Expected a form_references row for the condition's Use-Global comparison");
        Assert.Equal(_globalFormKey.ToString(), reader.GetString(1));
    }

    // The actual issue-described behavior, one level above the raw table checks above: a record
    // referenced only by a condition (never by an ordinary field or VMAD) must appear in
    // GetReferences' result — i.e. show up in the Referenced-By tab.
    [Fact]
    public void GetReferences_RecordReferencedOnlyByCondition_ReturnsReferencingRecord()
    {
        using var repo = LoadedRepository();
        var references = repo.GetReferencedBy(_referenceTargetFormKey.ToString());

        var reference = Assert.Single(references);
        Assert.Equal(_runOnRefCobjFormKey.ToString(), reference.FormKey);
        Assert.Equal("CtdaTest.esp", reference.Plugin);
    }
}
