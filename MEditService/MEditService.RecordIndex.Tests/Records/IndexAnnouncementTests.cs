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

    private void ReconcileHeld() => _index.Reconcile(_holder, _dataFolder, [Entry], GameRelease.Fallout4, _instanceRoot);

    [Fact]
    public void ABinaryReDerived_AnnouncesPluginChangedOnce_AtTheSequenceItLandedOn()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();
        var before = _notifications.Notifications.Count;

        PluginBinaries.Touch(_pluginPath);
        _index.NextCheck();

        var changed = Assert.Single(_notifications.Since(before).OfType<PluginChangedNotification>());
        Assert.Equal(Key, changed.Plugin);
        Assert.Equal(_index.Sequence, changed.Sequence);
    }

    [Fact]
    public void ABinaryGoneWhileTheIndexWasClosed_HasItsRowsRemoved_AndIsAnnouncedAsChanged_WhenTheIndexReopens()
    {
        WriteValidPlugin(_pluginPath);
        ReconcileHeld();
        _index.Dispose();
        File.Delete(_pluginPath);
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder, notifications: notifications);

        reopened.Reconcile(holder, _dataFolder, [Entry], GameRelease.Fallout4, _instanceRoot);

        Assert.Empty(reopened.ListedIn(Key));
        Assert.Contains(notifications.Notifications.OfType<PluginChangedNotification>(), changed => changed.Plugin.Equals(Key));
    }
}
