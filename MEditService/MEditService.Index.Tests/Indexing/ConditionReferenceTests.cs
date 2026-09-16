using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>Mutagen aliases <c>ParameterOneNumber</c> and <c>ParameterOneRecord</c> onto the same four
/// bytes, so an unfiltered walk would file a quest stage index as a reference.</summary>
public class ConditionReferenceTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new(Reflector);

    private static List<string> ConditionRefPaths(PluginFixtureData fixture, FormKey source, string plugin)
    {
        using var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(plugin), Path.Combine(fixture.DataFolder, plugin)), Fallout4Release.Fallout4);
        repo.IndexMod(mod, Registration.Participating(0), new PluginCopyKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT field_path FROM form_references WHERE source_form_key = $1 ORDER BY field_path";
        cmd.Parameters.Add(new DuckDBParameter { Value = source.ToString() });
        using var reader = cmd.ExecuteReader();
        var paths = new List<string>();
        while (reader.Read()) paths.Add(reader.GetString(0));
        return paths;
    }

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
            ["Conditions[0].Data.ParameterOneRecord"],
            ConditionRefPaths(fixture, cobj, "CondRefs.esp"));
    }

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
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("CondCheck.esp"), Path.Combine(fixture.DataFolder, "CondCheck.esp")),
            Fallout4Release.Fallout4);
        repo.IndexMod(mod, Registration.Participating(0), new PluginCopyKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        var document = repo.At(RecordRef.Effective)
            .GetDocument(cobj.ToString(), new PluginCopyKey("CondCheck.esp", "Data"))
            ?? throw new InvalidOperationException($"Expected a document for indexed record '{cobj}'.");
        var conditions = document.Fields.Single(f => f.Metadata.Name == "Conditions");

        Assert.Null(conditions.CheckError);
    }

    [Theory]
    [InlineData(Condition.RunOnType.Reference, "Conditions[0].Data.Reference")]
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
