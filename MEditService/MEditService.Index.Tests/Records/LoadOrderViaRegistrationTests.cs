using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public class LoadOrderViaRegistrationTests
{
    [Fact]
    public void Reorder_ViaRegisterOnly_FlipsTheWinner_WithNoRecordRowTouched()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("reorder-via-register")
            .WithPlugin("PluginA.esm", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("PluginB.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("PluginA.esm") });
                mod.Npcs.Set(built[0].Npcs.First().DeepCopy());
            })
            .Build();
        var aKey = new PluginAddress("PluginA.esm", "Data");
        var bKey = new PluginAddress("PluginB.esp", "Data");
        var holder = new LoadOrderHolder();
        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        var reads = index.RequireReads();

        var beforeA = reads.DocumentsOf(aKey);
        var beforeB = reads.DocumentsOf(bKey);
        var openedBefore = opens.OpenedTotal;
        var stackBeforeReorder = reads.GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.");
        Assert.True(stackBeforeReorder.Entries
            .Single(e => e.Plugin.Name == bKey.Name).IsWinner, "B, later in load order, should win before reorder.");

        var swappedSoBSortsBeforeA = fixture.Plugins.Select(p => p with { Slot = p.Name == "PluginA.esm" ? 1 : 0 }).ToList();
        index.Reconcile(holder, fixture.DataFolder, swappedSoBSortsBeforeA, GameRelease.Fallout4);

        var stack = (reads.GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.")).Entries;
        Assert.True(stack.Single(e => e.Plugin.Name == aKey.Name).IsWinner, "A, now later, should win after reorder.");
        Assert.False(stack.Single(e => e.Plugin.Name == bKey.Name).IsWinner);

        Assert.Equal(openedBefore, opens.OpenedTotal);
        Assert.Equal(Bodies(beforeA), Bodies(reads.DocumentsOf(aKey)));
        Assert.Equal(Bodies(beforeB), Bodies(reads.DocumentsOf(bKey)));
    }

    private static IReadOnlyList<(string FormKey, string? Body)> Bodies(IReadOnlyList<RecordDocument> documents) =>
        [.. documents.Select(d => (d.FormKey, d.Body))];
}
