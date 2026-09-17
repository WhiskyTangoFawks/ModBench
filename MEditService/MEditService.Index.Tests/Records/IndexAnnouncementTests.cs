using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

// ADR-0015 invariant 3: the Index is the one announcer. Every landing it owns publishes exactly
// once through its own announce door, carrying the sequence the store reached.
public sealed class IndexAnnouncementTests : IDisposable
{
    private const string PluginName = "Watched.esp";
    private const string Origin = "WatchedMod";
    private static readonly PluginCopyKey Key = new(PluginName, Origin);

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly LoadOrderHolder _holder = new();
    private readonly IndexProjector _index;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-announce-game-").FullName;
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-announce-instance-").FullName;
    private readonly string _pluginPath;

    public IndexAnnouncementTests()
    {
        _index = Indexes.Open(_holder, notifications: _notifications);
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
        mod.Npcs.AddNew("WatchedNpc");
        mod.WriteToBinary(path);
    }

    // Everything published after the reconcile: the landing under test is what follows it.
    private int _publishedByReconcile;

    private IEnumerable<Notification> SinceReconcile => _notifications.Notifications.Skip(_publishedByReconcile);

    private void ReconcileHeld()
    {
        _index.Reconcile(_holder, _gameDirectory, [Entry], GameRelease.Fallout4, _instanceRoot);
        _publishedByReconcile = _notifications.Notifications.Count;
    }

    private void TheOnePluginChanged()
    {
        var changed = Assert.Single(SinceReconcile.OfType<PluginChangedNotification>());
        Assert.Equal(Key, changed.Plugin);
        Assert.Equal(_index.Sequence, changed.Sequence);
    }

    [Fact]
    public async Task ABinaryReDerived_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        PluginBinaries.Touch(_pluginPath);
        Assert.True(await _index.RefreshBinary(Key, _pluginPath));

        TheOnePluginChanged();
    }

    [Fact]
    public async Task ABinaryGone_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        File.Delete(_pluginPath);
        Assert.True(await _index.RefreshBinary(Key, _pluginPath));

        TheOnePluginChanged();
    }

    [Fact]
    public async Task ABinaryIndexedForTheFirstTime_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn()
    {
        File.WriteAllText(_pluginPath, "not a plugin");
        ReconcileHeld();

        WriteValidPlugin(_pluginPath);
        Assert.True(await _index.RefreshBinary(Key, _pluginPath));

        TheOnePluginChanged();
    }

    // The rival this pins: identical bytes settling again, which must announce nothing — a
    // subscriber told to re-read would find nothing changed.
    [Fact]
    public async Task IdenticalBytesSettlingAgain_AnnounceNothing()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        Assert.False(await _index.RefreshBinary(Key, _pluginPath));

        Assert.Empty(SinceReconcile.OfType<PluginChangedNotification>());
    }

    [Fact]
    public void AValidateThatRebuiltACopy_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        PluginBinaries.Touch(_pluginPath);
        var report = Assert.Single(_index.ValidateIndex(Key));
        Assert.True(report.NeedsRebuild);

        TheOnePluginChanged();
    }

    [Fact]
    public void ARebuild_AnnouncesTheStatusItLeft()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        _index.RebuildStore(GameRelease.Fallout4, _instanceRoot);

        var status = Assert.Single(SinceReconcile.OfType<LoadOrderStatusNotification>());
        Assert.Equal(LoadOrderState.None, status.Status.State);
        Assert.Empty(SinceReconcile.OfType<PluginChangedNotification>());
    }
}
