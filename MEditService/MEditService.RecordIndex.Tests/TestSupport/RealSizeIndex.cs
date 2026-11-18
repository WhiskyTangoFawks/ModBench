using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The record index over a <see cref="RealSizeModlist"/>, built the first time a test of the run asks for it.
/// A test that changes the modlist or the load order restores it before it ends.</summary>
public sealed class RealSizeIndex : IDisposable
{
    private static readonly TimeSpan IndexingPatience = TimeSpan.FromHours(1);

    private readonly Lazy<RealSizeModlist> _modlist;
    private OpenedIndex? _index;
    private string? _leftChanged;

    public RealSizeIndex() : this(() => new RealSizeModlist())
    {
    }

    internal RealSizeIndex(Func<RealSizeModlist> generate)
    {
        _modlist = new(() => Build(generate));
        Source = new(new GitSourceAdapter(_unsaved, TimeProvider.System));
    }

    internal RealSizeModlist Modlist => _modlist.Value;

    internal OpenedIndex Index
    {
        get
        {
            if (_leftChanged is { } why) throw new InvalidOperationException($"An earlier test left the shared index changed: {why}");
            _ = _modlist.Value;
            return _index.Require();
        }
    }

    private RealSizeModlist Build(Func<RealSizeModlist> generate)
    {
        var modlist = generate();
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

    /// <summary>The source adapter the record index reads through, counting how it reads.</summary>
    internal CountingTreeSource Source { get; }

    private readonly UnsavedDocuments _unsaved = new();

    private OpenedIndex Launch(RealSizeModlist modlist) =>
        Indexes.Reconciled(modlist.DataFolder, modlist.LoadOrder, modlist.InstanceRoot, source: Source, patience: IndexingPatience, unsaved: _unsaved);

    /// <summary>The record index closed and launched again over the same file.</summary>
    internal void Relaunch() => Restore(() =>
    {
        Index.Dispose();
        _index = Launch(Modlist);
    }, () => true);

    /// <summary>The record index closed and launched again over the same file, answered once its reconcile has opened
    /// the file. The task ends with the reconcile.</summary>
    internal Task Relaunching()
    {
        Index.Dispose();
        var holder = new LoadOrderHolder();
        var index = Indexes.Open(holder, source: Source, unsaved: _unsaved);
        _index = index;
        holder.Apply(Modlist.Snapshot());
        Waits.Reached(() => index.Status.State == LoadOrderState.Reconciling, "the relaunch's reconcile", IndexingPatience);
        return Task.Run(() => Waits.Reached(() => index.Status.State == LoadOrderState.Ready, "the relaunch's end", IndexingPatience));
    }

    /// <summary>Applies <paramref name="snapshot"/> and waits for the index to answer it.</summary>
    internal void Receive(LoadOrderSnapshot snapshot) => Index.Receive(Index.Holder, snapshot);

    /// <summary>Runs <paramref name="putBack"/> and waits until <paramref name="restored"/> holds. A restore that fails
    /// fails every test after it, naming itself.</summary>
    internal void Restore(Action putBack, Func<bool> restored, TimeSpan? patience = null)
    {
        try
        {
            putBack();
            Waits.Reached(restored, "the shared index restored", patience);
            IndexFiles.Checkpointed(_modlist.Value.InstanceRoot);
        }
        catch (Exception ex)
        {
            _leftChanged = ex.Message;
            throw;
        }
    }

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
