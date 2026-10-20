using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Parks a read in the source adapter's tree lookup until the test releases it: the point
/// where a query holds the Index's reads and has not yet opened a connection on them.</summary>
internal sealed class ParkingSource : ISourceAdapter, IDisposable
{
    private readonly ISourceAdapter _inner = TestAdapters.Source();
    private readonly SemaphoreSlim _released = new(0, 1);
    private readonly SemaphoreSlim _arrived = new(0, 1);

    private int _armed;

    public void ParkNextTreeLookup() => Volatile.Write(ref _armed, 1);

    public async Task WaitUntilParkedAsync() => await _arrived.WaitAsync(TimeSpan.FromSeconds(30));

    public void Release() => _released.Release();

    public void Dispose()
    {
        _released.Dispose();
        _arrived.Dispose();
    }

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release)
    {
        if (Interlocked.Exchange(ref _armed, 0) == 0) return _inner.TreeOf(plugin, release);
        _arrived.Release();
        if (!_released.Wait(TimeSpan.FromSeconds(30))) throw new TimeoutException("the parked read was never released");
        return _inner.TreeOf(plugin, release);
    }

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) => _inner.Over(plugin, release);

    public bool SourceReads(RegisteredPlugin plugin) => _inner.SourceReads(plugin);

    public bool IsSourceMod(RegisteredPlugin plugin) => _inner.IsSourceMod(plugin);

    public bool IsSourceMod(string modFolder) => _inner.IsSourceMod(modFolder);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => _inner.WhySourceDoesNotRead(plugin);

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => _inner.Open(provider, release);

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => _inner.OverFolder(provider, release);

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        _inner.WriteSessionOver(provider, release, held);

    public bool TreeHolds(RegisteredPlugin plugin, string path) => _inner.TreeHolds(plugin, path);

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => _inner.RecordOfFile(loadOrder, path);

    public string FileNameOf(RecordIdentity identity) => _inner.FileNameOf(identity);

    public bool HoldsAnotherRepository(string modFolder) => _inner.HoldsAnotherRepository(modFolder);

    public SourceFailure? WhyGitCannotRun() => _inner.WhyGitCannotRun();

    public string? InstanceRootNotFound(string? instanceRoot) => _inner.InstanceRootNotFound(instanceRoot);

    public string ContentStamp(string text) => _inner.ContentStamp(text);

    public SourceFailure? Init(
        string sourceFolder, string output, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets) =>
        _inner.Init(sourceFolder, output, plugins, assets);

    public Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder) => _inner.SourceToBuild(sourceFolder);

    public Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel) => _inner.CommitAtHead(submodule, cancel);

    public SourceFailure? ChangeBuildConfiguration(string sourceFolder, BuildConfigurationChange change) =>
        _inner.ChangeBuildConfiguration(sourceFolder, change);

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        _inner.ReadBackOf(pluginFileName, tree, gameRelease);
}
