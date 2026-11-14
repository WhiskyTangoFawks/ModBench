using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The record index over a <see cref="RealSizeModlist"/>, built the first time a test of the run asks for it.</summary>
public sealed class RealSizeIndex : IDisposable
{
    private static readonly TimeSpan IndexingPatience = TimeSpan.FromHours(1);

    private readonly Lazy<(RealSizeModlist Modlist, OpenedIndex Index)> _built = new(Build);

    internal RealSizeModlist Modlist => _built.Value.Modlist;

    internal OpenedIndex Index => _built.Value.Index;

    private static (RealSizeModlist, OpenedIndex) Build()
    {
        var modlist = new RealSizeModlist();
        var holder = new LoadOrderHolder();
        var index = Indexes.Open(holder);
        var version = holder.Apply(SnapshotPlugins.Snapshot(modlist.DataFolder, modlist.InstanceRoot, GameRelease.Fallout4, modlist.LoadOrder));
        if (!Waits.ReachedWithin(() => index.Status.Version >= version && index.Status.State == LoadOrderState.Ready, IndexingPatience))
            throw new TimeoutException($"The record index of real size was not ready within {IndexingPatience}: {index.Status.State} {index.Status.Message}");
        return (modlist, index);
    }

    public void Dispose()
    {
        if (!_built.IsValueCreated) return;
        _built.Value.Index.Dispose();
        _built.Value.Modlist.Dispose();
    }
}

/// <summary>Tests on the record index of real size, run alone in the gate of their own.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class RealSizeCollection : ICollectionFixture<RealSizeIndex>
{
    public const string Name = "Real size";
}

/// <summary>Skipped without MEDIT_REAL_SIZE=1: building the record index of real size takes minutes, so the gate of
/// its own runs it.</summary>
public sealed class RealSizeFactAttribute : FactAttribute
{
    public RealSizeFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("MEDIT_REAL_SIZE") != "1")
            Skip = "Set MEDIT_REAL_SIZE=1 to build the record index of real size.";
    }
}
