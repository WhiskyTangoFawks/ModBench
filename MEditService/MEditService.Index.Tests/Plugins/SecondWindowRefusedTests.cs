using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

// ADR-0009 invariant 5: a DuckDB file admits one writing process and Modbench runs one service per
// window, so a second window is refused plainly, with no read-only mode and no second file.
public sealed class SecondWindowRefusedTests
{
    private static Indexer MakeIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    // One story, because the three assertions are one lifecycle: refused while the first
    // holds the file, nothing minted on disk meanwhile, admitted once the first lets go.
    [ForeignIndexHolderFact]
    public void ASecondWindowOnTheSameInstance_IsRefusedByName_StaysNone_AndLoadsOnceTheFirstCloses()
    {
        var holder = new LoadOrderHolder();
        using var data = new PluginFixtureBuilder("second-window")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        // The file exists with real rows before the other window takes it, so the final load is warm.
        using (var earlier = MakeIndex(holder)) earlier.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var indexPath = IndexFiles.In(data.InstanceRoot);
        var indexDir = Path.GetDirectoryName(indexPath) ?? throw new InvalidOperationException($"Expected '{indexPath}' to have a parent directory.");

        using var otherWindow = ForeignIndexHolder.Hold(indexPath);
        var filesWhileHeld = Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList();

        using var index = MakeIndex(holder);
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);

        // Refused by name, and nothing held.
        Assert.Equal(LoadOrderState.HeldElsewhere, index.Status.State);
        Assert.Contains("another Modbench window", index.Status.Message, StringComparison.Ordinal);
        Assert.Throws<NoLoadOrderException>(() => index.RequireReads());
        // Never a second file — and the held one was not deleted out from under the other
        // window: the directory is exactly as the holder had it.
        Assert.Equal(filesWhileHeld, Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList());

        // The other window closing admits this one — warm, over the rows the file already had.
        otherWindow.Dispose();
        index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.NotEmpty(index.RequireReads().GetDocuments(new PluginCopyKey("A.esp", PluginOrigin.DataDirectory)));
    }
}
