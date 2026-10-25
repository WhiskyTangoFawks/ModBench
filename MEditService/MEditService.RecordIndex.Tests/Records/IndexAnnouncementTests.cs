using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class IndexAnnouncementTests : IDisposable
{
    private const string PluginName = "Watched.esp";
    private const string Origin = "WatchedMod";
    private static readonly PluginAddress Key = new(PluginName, Origin);

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly ScratchDirectory _dataFolder = new("medit-announce-data-");
    private readonly ScratchDirectory _instanceRoot = new("medit-announce-instance-");
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
        _dataFolder.Dispose();
        _instanceRoot.Dispose();
    }

    private LoadOrderEntry Entry => new(PluginName, _pluginPath, Origin, 0, Enabled: true, Winning: true);

    private static void WriteValidPlugin(string path)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("WatchedNpc");
        mod.WriteToBinary(path);
    }

    private int _publishedByReconcile;

    private IEnumerable<INotification> SinceReconcile => _notifications.Notifications.Skip(_publishedByReconcile);

    private void ReconcileHeld()
    {
        _index.Reconcile(_holder, _dataFolder, [Entry], GameRelease.Fallout4, _instanceRoot);
        _publishedByReconcile = _notifications.Notifications.Count;
    }

    private void TheOnePluginChanged()
    {
        var changed = Assert.Single(SinceReconcile.OfType<PluginChangedNotification>());
        Assert.Equal(Key, changed.Plugin);
        Assert.Equal(_index.Sequence, changed.Sequence);
    }

    private static readonly Dictionary<string, Action<string>> BinaryChanges = new()
    {
        ["re-derived"] = PluginBinaries.Touch,
        ["gone"] = File.Delete,
    };

    [Theory]
    [InlineData("re-derived")]
    [InlineData("gone")]
    public void ABinaryChanged_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn(string change)
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        BinaryChanges[change](_pluginPath);
        _index.NextSnapshot();

        TheOnePluginChanged();
    }

    [Fact]
    public void ABinaryGoneWhileTheIndexWasClosed_IsAnnouncedAsChanged_WhenTheIndexReopens()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();
        _index.Dispose();
        File.Delete(_pluginPath);
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder, notifications: notifications);

        reopened.Reconcile(holder, _dataFolder, [Entry], GameRelease.Fallout4, _instanceRoot);

        Assert.Contains(notifications.Notifications.OfType<PluginChangedNotification>(), changed => changed.Plugin.Equals(Key));
    }

    [Fact]
    public async Task IdenticalBytesSettlingAgain_AnnounceNothing()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();
        var otherPath = Path.Combine(_dataFolder, "Other.esp");
        var other = new Fallout4Mod(ModKey.FromFileName("Other.esp"), Fallout4Release.Fallout4);
        other.Npcs.AddNew("OtherNpc");
        other.WriteToBinary(otherPath);
        _index.Reconcile(_holder, _dataFolder, [Entry, new("Other.esp", otherPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true)], GameRelease.Fallout4, _instanceRoot);
        _publishedByReconcile = _notifications.Notifications.Count;
        PluginBinaries.Touch(otherPath);

        _index.NextSnapshot();

        Assert.DoesNotContain(SinceReconcile.OfType<PluginChangedNotification>(), n => n.Plugin.Equals(Key));
    }

    [Fact]
    public void ARebuild_AnnouncesTheStatusItLeft()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();

        _index.Queries.RebuildStore(GameRelease.Fallout4, _instanceRoot);

        var status = Assert.Single(SinceReconcile.OfType<LoadOrderStatusNotification>());
        Assert.Equal(LoadOrderState.None, status.Status.State);
        Assert.Empty(SinceReconcile.OfType<PluginChangedNotification>());
    }
}
