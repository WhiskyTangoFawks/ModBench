using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

public class MissingReferenceTests
{
    private const string Referrer = "Referrer";
    private static readonly PluginAddress Refers = new("Refers.esp", "RefersMod");

    private static readonly FormKey AbsentRecord = FormKey.Factory("000ABC:Absent.esp");
    private static readonly FormKey EngineDefined = FormKey.Factory("000007:Fallout4.esm");
    private static readonly FormKey FirstHeldRangeFormId = FormKey.Factory("000800:Fallout4.esm");

    private static List<(PluginAddress Plugin, SourceProblem Problem)> MissingReferencesOf(ScatteredFixtureData fixture)
    {
        using var index = Indexes.Reconciled(fixture.Tracked());
        var problems = index.Queries.GetProblems().Value() ?? throw new InvalidOperationException("Expected the index to be ready.");
        return [.. problems.SelectMany(plugin => plugin.Problems.Select(problem => (plugin.Plugin, problem)))];
    }

    [Fact]
    public void ReportingMissingReferences_ALinkToARecordNoPluginHolds_NamesTheReferrerAndTheTarget()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("missing-ref-absent")
            .WithPlugin(Refers.Name, mod =>
            {
                var added = mod.Npcs.AddNew(Referrer);
                npc = added.FormKey;
                added.Race.SetTo(AbsentRecord);
            }, origin: Refers.Origin)
            .BuildScattered();

        var (plugin, missing) = Assert.Single(MissingReferencesOf(fixture));

        Assert.Equal(
            (Refers, npc.ToString(), AbsentRecord.ToString(), "Race"),
            (plugin, missing.FormKey, missing.TargetFormKey, missing.FieldPath));
    }

    [Fact]
    public void ReportingMissingReferences_ALinkToARecordAnActivePluginHolds_IsNotReported()
    {
        using var fixture = new PluginFixtureBuilder("missing-ref-held")
            .WithPlugin(Refers.Name, mod =>
            {
                var race = mod.Races.AddNew("Held");
                mod.Npcs.AddNew(Referrer).Race.SetTo(race.FormKey);
            }, origin: Refers.Origin)
            .BuildScattered();

        Assert.Empty(MissingReferencesOf(fixture));
    }

    [Fact]
    public void ReportingMissingReferences_AnEngineDefinedFormIdInABaseMaster_IsNotReported_ButTheFirstHeldRangeFormIdIs()
    {
        using var fixture = new PluginFixtureBuilder("missing-ref-engine")
            .WithPlugin(Refers.Name, mod =>
            {
                mod.Npcs.AddNew("Engine").Race.SetTo(EngineDefined);
                mod.Npcs.AddNew("Beyond").Race.SetTo(FirstHeldRangeFormId);
            }, origin: Refers.Origin)
            .BuildScattered();

        var (_, missing) = Assert.Single(MissingReferencesOf(fixture));

        Assert.Equal(FirstHeldRangeFormId.ToString(), missing.TargetFormKey);
    }

    [Fact]
    public void ReportingMissingReferences_ALinkToARecordOnlyAnInactivePluginHolds_IsReported()
    {
        FormKey inactiveRace = default;
        using var fixture = new PluginFixtureBuilder("missing-ref-inactive")
            .WithPlugin("Dormant.esp", mod => inactiveRace = mod.Races.AddNew("Dormant").FormKey, enabled: false, origin: "DormantMod")
            .WithPlugin(Refers.Name, mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Dormant.esp") });
                mod.Npcs.AddNew(Referrer).Race.SetTo(inactiveRace);
            }, origin: Refers.Origin)
            .BuildScattered();

        var (_, missing) = Assert.Single(MissingReferencesOf(fixture));

        Assert.Equal(inactiveRace.ToString(), missing.TargetFormKey);
    }
}
