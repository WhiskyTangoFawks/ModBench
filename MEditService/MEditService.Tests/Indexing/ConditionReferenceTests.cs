using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #692: a condition's FormKey-bearing members reach Referenced By through the one reflected
/// form-ref walk — and only the ones the condition actually uses do.
///
/// <para>Mutagen aliases a condition's <c>ParameterOneNumber</c> and <c>ParameterOneRecord</c> onto
/// the same four bytes and reads both off every condition, so an unfiltered walk would file a quest
/// stage index as a reference to whatever record happens to hold that FormID, and a Run On of
/// Subject would still point at whatever reference the condition last carried. What the function
/// and the Run On value say is in use is the filter — <c>FieldMetadata.SiblingsInUse</c>, read by
/// <c>FormRefPathBuilder</c>.</para>
/// </summary>
public class ConditionReferenceTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new(Reflector);

    private static List<string> ConditionRefPaths(PluginFixtureData fixture, FormKey source, string plugin)
    {
        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(plugin), Path.Combine(fixture.DataFolder, plugin)), Fallout4Release.Fallout4);
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT field_path FROM form_references WHERE source_form_key = $1 ORDER BY field_path";
        cmd.Parameters.Add(new DuckDBParameter { Value = source.ToString() });
        using var reader = cmd.ExecuteReader();
        var paths = new List<string>();
        while (reader.Read()) paths.Add(reader.GetString(0));
        return paths;
    }

    /// <summary>The two slots <c>GetStageDone</c> uses are a quest link and a stage number. Only the
    /// first is a reference; the second is a number that shares its bytes with a link Mutagen will
    /// happily read as one.</summary>
    [Fact]
    public void AFormParameterIsAReference_AndANumberParameterSharingItsBytesIsNot()
    {
        FormKey cobj = default;
        using var fixture = new PluginFixtureBuilder("cond-refs-parameters")
            .WithPlugin("CondRefs.esp", mod =>
            {
                var quest = mod.Quests.AddNew("RefQuest");
                var data = new FunctionConditionData
                {
                    Function = Condition.Function.GetStageDone,
                    // A stage index that is also this plugin's own first FormID — an unfiltered walk
                    // would file it as a reference to the quest above.
                    ParameterTwoNumber = (int)quest.FormKey.ID,
                };
                data.ParameterOneRecord.SetTo(quest.FormKey);
                var recipe = mod.ConstructibleObjects.AddNew("RefRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();

        Assert.Equal(
            ["conditions[0].data.parameter_one_record"],
            ConditionRefPaths(fixture, cobj, "CondRefs.esp"));
    }

    /// <summary>The same idle-member rule read from the other side: a check error is a claim that a
    /// link is broken, and an idle slot has no link to break. Real Fallout 4 quest data flagged
    /// every condition whose Run On is not Reference before this rule existed.</summary>
    [Fact]
    public void AnIdleMemberIsNotFlaggedAsABrokenLink()
    {
        FormKey cobj = default;
        using var fixture = new PluginFixtureBuilder("cond-refs-checkerror")
            .WithPlugin("CondCheck.esp", mod =>
            {
                var data = new FunctionConditionData
                {
                    Function = Condition.Function.IsSneaking,   // uses no parameter slot at all
                    RunOnType = Condition.RunOnType.Subject,    // so Reference is idle and unset
                };
                var recipe = mod.ConstructibleObjects.AddNew("CheckRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();

        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        var mod = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("CondCheck.esp"), Path.Combine(fixture.DataFolder, "CondCheck.esp")),
            Fallout4Release.Fallout4);
        repo.Index(mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var document = repo.At(RecordRef.Effective)
            .GetDocument(cobj.ToString(), new PluginKey("CondCheck.esp", "Data"))!;
        var conditions = document.Fields.Single(f => f.Metadata.Name == "conditions");

        Assert.Null(conditions.CheckError);
    }

    [Theory]
    [InlineData(Condition.RunOnType.Reference, "conditions[0].data.reference")]
    [InlineData(Condition.RunOnType.Subject, null)]
    public void TheRunOnReferenceIsAReferenceOnlyUnderTheReferenceRunOn(
        Condition.RunOnType runOn, string? expected)
    {
        FormKey cobj = default;
        using var fixture = new PluginFixtureBuilder($"cond-refs-runon-{runOn}")
            .WithPlugin("CondRunOn.esp", mod =>
            {
                var quest = mod.Quests.AddNew("RunOnQuest");
                // IsSneaking uses no parameter slot at all, so the only link in play is the Run On
                // target — which the record carries whatever the Run On value says.
                var data = new FunctionConditionData { Function = Condition.Function.IsSneaking, RunOnType = runOn };
                data.Reference.SetTo(quest.FormKey);
                var recipe = mod.ConstructibleObjects.AddNew("RunOnRecipe");
                cobj = recipe.FormKey;
                recipe.Conditions.Add(new ConditionFloat { ComparisonValue = 1f, Data = data });
            })
            .Build();

        Assert.Equal(
            expected == null ? [] : new[] { expected },
            ConditionRefPaths(fixture, cobj, "CondRunOn.esp"));
    }
}
