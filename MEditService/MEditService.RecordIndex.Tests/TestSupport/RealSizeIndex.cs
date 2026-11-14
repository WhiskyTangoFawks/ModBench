using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The record index over a <see cref="RealSizeModlist"/>, built the first time a test of the run asks for it.
/// A test that changes the modlist or the load order restores it before it ends.</summary>
public sealed class RealSizeIndex : IDisposable
{
    private static readonly TimeSpan IndexingPatience = TimeSpan.FromHours(1);

    private readonly Lazy<RealSizeModlist> _modlist;
    private OpenedIndex? _index;

    public RealSizeIndex() => _modlist = new(Build);

    internal RealSizeModlist Modlist => _modlist.Value;

    internal OpenedIndex Index
    {
        get
        {
            _ = _modlist.Value;
            return _index.Require();
        }
    }

    private RealSizeModlist Build()
    {
        var modlist = new RealSizeModlist();
        try
        {
            _index = Launch(modlist);
            return modlist;
        }
        catch
        {
            modlist.Dispose();
            throw;
        }
    }

    private static OpenedIndex Launch(RealSizeModlist modlist) =>
        Indexes.Reconciled(modlist.DataFolder, modlist.LoadOrder, modlist.InstanceRoot, patience: IndexingPatience);

    /// <summary>The record index closed and launched again over the same file.</summary>
    internal void Relaunch()
    {
        Index.Dispose();
        _index = Launch(Modlist);
    }

    /// <summary>Applies <paramref name="snapshot"/> and waits for the index to answer it.</summary>
    internal void Receive(LoadOrderSnapshot snapshot) => Index.Receive(Index.Holder, snapshot);

    public void Dispose()
    {
        if (!_modlist.IsValueCreated) return;
        _index?.Dispose();
        _modlist.Value.Dispose();
    }
}

/// <summary>The tests on the record index of real size, one at a time.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class RealSizeCollection : ICollectionFixture<RealSizeIndex>
{
    public const string Name = "Real size";
}
