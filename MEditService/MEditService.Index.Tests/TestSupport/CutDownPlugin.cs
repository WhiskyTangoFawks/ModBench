using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>An index over the committed cut-down Fallout 4 plugin: real game data without the
/// 316 MB master, so the fixture is hermetic. `CutDownPluginGenerator` in
/// MEditService.TestSupport regenerates the file when the schema or curation changes.</summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public static readonly PluginAddress Plugin = new(RealDataPlugin.PluginFileName, PluginOrigin.DataDirectory);

    public string InstanceRoot { get; } = Directory.CreateTempSubdirectory("medit-cutdown-instance-").FullName;

    internal Indexer Index { get; }

    public IRecordReads Reads => Index.RequireReads();

    public CutDownPluginFixture()
    {
        var gameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "GameDir")).FullName;
        Index = Indexes.Reconciled(
            gameDirectory,
            [new LoadOrderEntry(
                RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, PluginOrigin.DataDirectory,
                Slot: 0, Enabled: true, Winning: true)],
            InstanceRoot);
        // The per-type views are made by the first filter (ADR-0011), and a test reads them.
        Index.Accepts("SELECT form_key FROM records");
    }

    public void Dispose()
    {
        Index.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); } catch (IOException) { /* scratch, best effort */ }
    }
}

/// <summary>One index over the cut-down plugin for the assembly, because indexing it costs seconds.
/// A member class only reads it: a test that sets the filter or changes rows builds its own.</summary>
[CollectionDefinition(Name)]
public sealed class CutDownPluginCollection : ICollectionFixture<CutDownPluginFixture>
{
    public const string Name = "Cut-down plugin";
}
