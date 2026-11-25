using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The record index over a <see cref="RealSizeModlist"/>, built the first time a soak of the run asks for it.</summary>
public sealed class RealSizeIndex : IDisposable
{
    private static readonly TimeSpan IndexingPatience = TimeSpan.FromHours(1);

    private readonly Lazy<(RealSizeModlist Modlist, OpenedIndex Index)> _built = new(Build);

    internal RealSizeModlist Modlist => _built.Value.Modlist;

    internal OpenedIndex Index => _built.Value.Index;

    private static (RealSizeModlist, OpenedIndex) Build()
    {
        var modlist = new RealSizeModlist();
        try
        {
            return (modlist, Indexes.Reconciled(modlist.DataFolder, modlist.LoadOrder, modlist.InstanceRoot, patience: IndexingPatience));
        }
        catch
        {
            modlist.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (!_built.IsValueCreated) return;
        _built.Value.Index.Dispose();
        _built.Value.Modlist.Dispose();
    }
}

/// <summary>The soaks on the record index of real size, one at a time.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class RealSizeCollection : ICollectionFixture<RealSizeIndex>
{
    public const string Name = "Real size";
}
