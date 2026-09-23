using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

// ADR-0009's other half of the watcher's binary route: the Index, never the watcher, owns the
// comparison a settle asks for. RefreshBinary is the one door a settle uses, key and path only.
public sealed class RefreshBinaryTests : IDisposable
{
    private readonly LoadOrderHolder _holder = new();
    private readonly Indexer _index;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-refresh-binary-game-").FullName;
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-refresh-binary-instance-").FullName;
    private const string PluginName = "Untracked.esp";
    private const string Origin = "UntrackedMod";
    private readonly string _pluginPath;
    private readonly PluginCopyKey _key = new(PluginName, Origin);

    public RefreshBinaryTests()
    {
        _index = Indexes.Open(_holder);
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, PluginName);
    }

    public void Dispose()
    {
        _index.Dispose();
        Directory.Delete(_gameDirectory, recursive: true);
        Directory.Delete(_instanceRoot, recursive: true);
    }

    private LoadOrderEntry Entry => new(PluginName, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private static void WriteValidPlugin(string path)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FreshlyAppearedNpc");
        mod.WriteToBinary(path);
    }

    // The rival this test rules out: the watcher's own hash bookkeeping deciding not-yet-indexed
    // copies are nothing to look at, the way it did before this poke moved the comparison here.
    [Fact]
    public async Task RefreshBinary_ForACopyThatFailedToOpenAtTheLastReconcile_IndexesItNow()
    {
        File.WriteAllText(_pluginPath, "not a plugin");
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        Assert.Contains(_index.Status.Failures, f => f.Name == PluginName);
        Assert.Empty(_index.RequireReads().GetDocuments(_key));

        WriteValidPlugin(_pluginPath);
        await _index.RefreshBinary(_key, _pluginPath);

        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == PluginName);
        Assert.Contains(_index.Status.IndexedPlugins, p => p.Name == PluginName && p.Origin == Origin);
        Assert.NotEmpty(_index.RequireReads().GetDocuments(_key));
    }

    [Fact]
    public async Task RefreshBinary_ForACopyAlreadyIndexed_UnchangedBytesSettlingAgainIsNotReindexed()
    {
        WriteValidPlugin(_pluginPath);
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        var landed = _index.Sequence;

        Assert.False(await _index.RefreshBinary(_key, _pluginPath));
        Assert.Equal(landed, _index.Sequence);
    }

    [Fact]
    public async Task RefreshBinary_ForACopyAlreadyIndexed_BytesThatArrivedExternallyAreReindexed()
    {
        WriteValidPlugin(_pluginPath);
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);

        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("ArrivedExternally");
        mod.WriteToBinary(_pluginPath);

        Assert.True(await _index.RefreshBinary(_key, _pluginPath));
        Assert.Contains(_index.RequireReads().GetDocuments(_key), d => d.EditorId == "ArrivedExternally");
    }

    [Fact]
    public async Task RefreshBinary_ForACopyGoneFromDisk_UnindexesIt()
    {
        WriteValidPlugin(_pluginPath);
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        Assert.NotEmpty(_index.RequireReads().GetDocuments(_key));

        File.Delete(_pluginPath);
        Assert.True(await _index.RefreshBinary(_key, _pluginPath));

        Assert.Empty(_index.RequireReads().GetDocuments(_key));
    }

    // The rival this pins: answering true for any missing path, which would tell a reader
    // something was re-fetched when a copy never indexed left nothing to remove.
    [Fact]
    public async Task RefreshBinary_ForACopyNeverIndexed_MissingFromDisk_AnswersFalse() =>
        Assert.False(await _index.RefreshBinary(_key, _pluginPath));

    // The bool itself, across every branch: true only for the two that actually changed something a
    // reader could re-fetch, false for "still failing" and "already matches" alike.
    [Fact]
    public async Task RefreshBinary_AnswersTrueOnlyWhenSomethingChanged()
    {
        File.WriteAllText(_pluginPath, "not a plugin");
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);

        File.WriteAllText(_pluginPath, "still not a plugin");
        var stillFailingToOpen = await _index.RefreshBinary(_key, _pluginPath);
        Assert.False(stillFailingToOpen);

        WriteValidPlugin(_pluginPath);
        var nowIndexedForTheFirstTime = await _index.RefreshBinary(_key, _pluginPath);
        Assert.True(nowIndexedForTheFirstTime);

        var identicalBytesResettling = await _index.RefreshBinary(_key, _pluginPath);
        Assert.False(identicalBytesResettling);
    }

    // The rival this pins: a not-yet-held failure that only logs, leaving Status at whatever it
    // already was — ADR-0019 bans a failure a subscriber has no way to learn about.
    [Fact]
    public async Task RefreshBinary_PublishesStatus_WhenACopyStillFailsToOpen()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Open(_holder, notifications: notifications);

        File.WriteAllText(_pluginPath, "not a plugin");
        index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        var before = notifications.Notifications.Count;

        File.WriteAllText(_pluginPath, "still not a plugin");
        Assert.False(await index.RefreshBinary(_key, _pluginPath));

        Assert.True(notifications.Notifications.Count > before);
        var published = Assert.IsType<LoadOrderStatusNotification>(notifications.Notifications[^1]);
        Assert.Contains(published.Status.Failures, f => f.Name == PluginName);
    }
}
