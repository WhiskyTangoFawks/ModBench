using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

// #588 / ADR-0001 point 6: a DuckDB file admits one writing process and Modbench runs one service
// per VS Code window, so a second window on the same instance is told plainly and refused — no
// read-only mode, no waiting, never a second file. Proved at the mirror seam, with the other window
// being a genuine second process (ForeignIndexHolder): DuckDB's lock is per process, and a second
// mirror inside this one would share the database rather than contend for it.
public sealed class SecondWindowRefusedTests
{
    private static LoadOrderMirror MakeMirror()
    {
        var reflector = SharedSchemaReflector.Instance;
        return new LoadOrderMirror(new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)));
    }

    // AC1 + AC2 + AC3 in one story, because the three are one lifecycle: refused while the first
    // holds the file, nothing minted on disk meanwhile, admitted once the first lets go.
    [ForeignIndexHolderFact]
    public void ASecondWindowOnTheSameInstance_IsRefusedByName_StaysNone_AndLoadsOnceTheFirstCloses()
    {
        using var data = new PluginFixtureBuilder("second-window")
            .WithPlugin("A.esp", m => m.Npcs.AddNew("NpcA"))
            .Build();
        // The file exists with real rows before the other window takes it, so AC3's load is warm.
        using (var earlier = MakeMirror()) earlier.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        var indexPath = IndexFile.For(data.InstanceRoot);
        var indexDir = Path.GetDirectoryName(indexPath)!;

        using var otherWindow = ForeignIndexHolder.Hold(indexPath);
        var filesWhileHeld = Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList();

        using var mirror = MakeMirror();
        var ex = Assert.Throws<IndexHeldElsewhereException>(() =>
            mirror.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot));

        // AC1: refused by name, and nothing held.
        Assert.Contains("another Modbench window", ex.Message, StringComparison.Ordinal);
        Assert.Equal(indexPath, ex.IndexPath);
        Assert.Equal(LoadOrderState.None, mirror.Status.State);
        // AC2: never a second file — and the held one was not deleted out from under the other
        // window (fe4d09c's near-miss): the directory is exactly as the holder had it.
        Assert.Equal(filesWhileHeld, Directory.GetFiles(indexDir).Select(Path.GetFileName).Order().ToList());

        // AC3: the other window closing admits this one — warm, over the rows the file already had.
        otherWindow.Dispose();
        mirror.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4, data.InstanceRoot);
        Assert.Equal(LoadOrderState.Ready, mirror.Status.State);
        Assert.NotEmpty(mirror.Index!.GetDocuments(new PluginKey("A.esp", PluginOrigin.DataDirectory)));
    }
}
