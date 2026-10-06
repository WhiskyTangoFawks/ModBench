using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

public class MissingReferenceTests
{
    private static readonly FormKey AbsentRecord = FormKey.Factory("000ABC:Absent.esp");
    private static readonly FormKey EngineDefined = FormKey.Factory("000007:Fallout4.esm");
    private static readonly FormKey FirstHeldRangeFormId = FormKey.Factory("000800:Fallout4.esm");

    [Fact]
    public void GetReferencesToMissingRecords_ALinkToARecordNoPluginHolds_NamesTheReferrerAndTheTarget()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("missing-ref-absent")
            .WithPlugin("Refers.esp", mod =>
            {
                var added = mod.Npcs.AddNew("Referrer");
                npc = added.FormKey;
                added.Race.SetTo(AbsentRecord);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var missing = Assert.Single(index.RequireReads().GetReferencesToMissingRecords());

        Assert.Equal(
            (new PluginAddress("Refers.esp", PluginOrigin.DataDirectory), npc.ToString(), "npc_", "Referrer", AbsentRecord.ToString(), "Race"),
            (missing.Plugin, missing.FormKey, missing.RecordType, missing.EditorId, missing.TargetFormKey, missing.FieldPath));
    }

    [Fact]
    public void GetReferencesToMissingRecords_ALinkToARecordAnActivePluginHolds_IsNotReported()
    {
        using var fixture = new PluginFixtureBuilder("missing-ref-held")
            .WithPlugin("Refers.esp", mod =>
            {
                var race = mod.Races.AddNew("Held");
                mod.Npcs.AddNew("Referrer").Race.SetTo(race.FormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Empty(index.RequireReads().GetReferencesToMissingRecords());
    }

    [Fact]
    public void GetReferencesToMissingRecords_AnEngineDefinedFormIdInABaseMaster_IsNotReported_ButTheFirstHeldRangeFormIdIs()
    {
        using var fixture = new PluginFixtureBuilder("missing-ref-engine")
            .WithPlugin("Refers.esp", mod =>
            {
                mod.Npcs.AddNew("Engine").Race.SetTo(EngineDefined);
                mod.Npcs.AddNew("Beyond").Race.SetTo(FirstHeldRangeFormId);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var missing = Assert.Single(index.RequireReads().GetReferencesToMissingRecords());

        Assert.Equal(FirstHeldRangeFormId.ToString(), missing.TargetFormKey);
    }

    [Fact]
    public void GetReferencesToMissingRecords_ALinkToARecordOnlyAnInactivePluginHolds_IsReported()
    {
        FormKey inactiveRace = default;
        using var fixture = new PluginFixtureBuilder("missing-ref-inactive")
            .WithPlugin("Dormant.esp", mod => inactiveRace = mod.Races.AddNew("Dormant").FormKey, enabled: false)
            .WithPlugin("Refers.esp", mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Dormant.esp") });
                mod.Npcs.AddNew("Referrer").Race.SetTo(inactiveRace);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Equal(inactiveRace.ToString(), Assert.Single(index.RequireReads().GetReferencesToMissingRecords()).TargetFormKey);
    }
}
