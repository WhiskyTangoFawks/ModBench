using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public class HardcodedFormKeyResolutionTests
{
    [Fact]
    public void GetDocument_FieldReferencesEngineHardcodedPlayerFormKey_NoCheckError()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("hardcoded-formkey")
            .WithPlugin("Hardcoded.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("PlayerReferencer");
                var playerHardcodedByTheEngineAndAbsentFromFormLookup = new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x000007);
                npc.Race.SetTo(playerHardcodedByTheEngineAndAbsentFromFormLookup);
                npcKey = npc.FormKey;
            }, origin: "ModA")
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("Hardcoded.esp", "ModA");

        var doc = index.RequireReads().GetDocument(npcKey.ToString(), key);

        Assert.NotNull(doc);
        var raceField = doc.Fields.Single(f => f.Metadata.Name.Equals("Race", StringComparison.OrdinalIgnoreCase));
        Assert.Null(raceField.CheckError);
    }
}
