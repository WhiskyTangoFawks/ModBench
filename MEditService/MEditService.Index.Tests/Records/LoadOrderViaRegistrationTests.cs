using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

// ADR-0009: load order lives only on the registrations. Reordering the load order re-reads no
// plugin and re-derives no document; override stacks follow the new order from that alone.
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

        var beforeA = reads.GetDocuments(aKey);
        var beforeB = reads.GetDocuments(bKey);
        var openedBefore = opens.OpenedTotal;
        var stackBeforeReorder = reads.GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.");
        Assert.True(stackBeforeReorder.Entries
            .Single(e => e.Plugin.Name == bKey.Name).IsWinner, "B, later in load order, should win before reorder.");

        // Reorder: B now sorts before A.
        var swapped = fixture.Plugins.Select(p => p with { Slot = p.Name == "PluginA.esm" ? 1 : 0 }).ToList();
        index.Reconcile(holder, fixture.DataFolder, swapped, GameRelease.Fallout4);

        var stack = (reads.GetOverrideStack(npcKey.ToString())
            ?? throw new InvalidOperationException($"Expected an override stack for '{npcKey}'.")).Entries;
        Assert.True(stack.Single(e => e.Plugin.Name == aKey.Name).IsWinner, "A, now later, should win after reorder.");
        Assert.False(stack.Single(e => e.Plugin.Name == bKey.Name).IsWinner);

        // The reorder re-read no plugin and re-derived no document.
        Assert.Equal(openedBefore, opens.OpenedTotal);
        Assert.Equal(ByFormKey(beforeA), ByFormKey(reads.GetDocuments(aKey)));
        Assert.Equal(ByFormKey(beforeB), ByFormKey(reads.GetDocuments(bKey)));
    }

    // GetDocuments is a set of rows with no order of its own, so the comparison imposes one:
    // a row order that varies under load is not a re-derived document.
    private static IReadOnlyList<(string FormKey, string? Body)> ByFormKey(IReadOnlyList<RecordDocument> documents) =>
        [.. documents.Select(d => (d.FormKey, d.Body)).OrderBy(d => d.FormKey, StringComparer.Ordinal)];
}
