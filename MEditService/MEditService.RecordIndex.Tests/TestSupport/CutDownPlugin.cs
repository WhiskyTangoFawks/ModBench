using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An index over the committed cut-down Fallout 4 plugin: real game data without the
/// 316 MB master, so the fixture is hermetic.</summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public static readonly PluginAddress Plugin = new(RealDataPlugin.PluginFileName, PluginOrigin.DataDirectory);

    private readonly ScratchDirectory _instance = new("medit-cutdown-instance-");

    public string InstanceRoot => _instance.Path;

    internal OpenedIndex Index { get; }

    public CutDownPluginFixture()
    {
        var dataFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "Data")).FullName;
        Index = Indexes.Reconciled(
            dataFolder,
            [new LoadOrderEntry(
                RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, PluginOrigin.DataDirectory,
                Line: 0, Enabled: true, Winning: true)],
            InstanceRoot);
    }

    public void Dispose()
    {
        Index.Dispose();
        _instance.Dispose();
    }
}

/// <summary>One index over the cut-down plugin for the assembly, because indexing it costs seconds.
/// A member class only reads it: a test that sets the filter or changes rows builds its own.</summary>
[CollectionDefinition(Name)]
public sealed class CutDownPluginCollection : ICollectionFixture<CutDownPluginFixture>
{
    public const string Name = "Cut-down plugin";
}
