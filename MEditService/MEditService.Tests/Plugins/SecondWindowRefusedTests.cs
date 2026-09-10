using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// ADR-0001 point 6: a DuckDB file admits one writing process and Modbench runs one service per
// window, so a second window is refused plainly, with no read-only mode and no second file.
public sealed class SecondWindowRefusedTests
{
    private static IndexProjector MakeIndex()
    {
        var reflector = SharedSchemaReflector.Instance;
        return new IndexProjector(MutagenPluginAdapter.Instance, new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
    }

    // One story, because the three assertions are one lifecycle: refused while the first
    // holds the file, nothing minted on disk meanwhile, admitted once the first lets go.
    [ForeignIndexHolderFact]
    public void ASecondWindowOnTheSameInstance_IsRefusedByName_StaysNone_AndLoadsOnceTheFirstCloses()
    {
        using var data = new PluginFixtureBuilder("second-window")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        // The file exists with real rows before the other window takes it, so the final load is warm.
        using (var earlier = MakeIndex()) earlier.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var indexPath = IndexFile.For(data.InstanceRoot);
        var indexDir = Path.GetDirectoryName(indexPath)!;

        using var otherWindow = ForeignIndexHolder.Hold(indexPath);
        var filesWhileHeld = Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList();

        using var index = MakeIndex();
        var ex = Assert.Throws<IndexHeldElsewhereException>(() =>
            index.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot));

        // Refused by name, and nothing held.
        Assert.Contains("another Modbench window", ex.Message, StringComparison.Ordinal);
        Assert.Equal(indexPath, ex.IndexPath);
        Assert.Equal(LoadOrderState.None, index.Status.State);
        // Never a second file — and the held one was not deleted out from under the other
        // window: the directory is exactly as the holder had it.
        Assert.Equal(filesWhileHeld, Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList());

        // The other window closing admits this one — warm, over the rows the file already had.
        otherWindow.Dispose();
        index.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Equal(LoadOrderState.Ready, index.Status.State);
        Assert.NotEmpty(index.Store!.At(RecordRef.Effective).GetDocuments(new PluginKey("A.esp", PluginOrigin.DataDirectory)));
    }
}
