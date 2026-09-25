using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

// End to end: the reconcile's GameRelease has to reach FormKeyResolution.From through BuildFields and
// CheckErrorBuilder.Build for the exemption to take effect on a real read.
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
                // 00000007:Fallout4.esm — the Player, engine-hardcoded, never present in form_lookup.
                npc.Race.SetTo(new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x000007));
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
