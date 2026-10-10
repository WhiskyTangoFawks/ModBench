using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class SequenceTrailsAnnouncementTests : IDisposable
{
    private const string PluginName = "Watched.esp";
    private const string Origin = "WatchedMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private volatile TaskCompletionSource _released = Opened();
    private volatile bool _holding;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly ScratchDirectory _gameDirectory = new("medit-trail-game-");
    private readonly ScratchDirectory _instanceRoot = new("medit-trail-instance-");
    private readonly string _pluginPath;

    public SequenceTrailsAnnouncementTests()
    {
        _notifications.OnPublish = HoldPluginChangedWhileHeld;
        _index = Indexes.Open(_holder, notifications: _notifications);
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, PluginName);
    }

    public void Dispose()
    {
        _released.TrySetResult();
        _index.Dispose();
        _gameDirectory.Dispose();
        _instanceRoot.Dispose();
    }

    [Fact]
    public async Task ASequenceBeyondWhatARederivedPluginStartedAt_IsReadOnlyOnceItsAnnouncementIsOut()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("WatchedNpc");
        mod.WriteToBinary(_pluginPath);
        var entry = new LoadOrderEntry(PluginName, _pluginPath, Origin, 0, Enabled: true, Winning: true);
        _index.Reconcile(_holder, _gameDirectory, [entry], GameRelease.Fallout4, _instanceRoot);
        var before = _index.Sequence;
        _released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        PluginBinaries.Touch(_pluginPath);
        _holder.Apply(_holder.Current);
        Waits.Reached(() => _holding, "the re-derive's announcement being published");
        var read = Task.Run(() => _index.Sequence);

        Assert.False(await Waits.CompletesWithin(read, TimeSpan.FromMilliseconds(300)));
        _released.TrySetResult();
        Assert.True(await read > before);
    }

    private void HoldPluginChangedWhileHeld(INotification notification)
    {
        if (notification is not PluginChangedNotification) return;
        _holding = true;
        _released.Task.Wait();
    }

    private static TaskCompletionSource Opened()
    {
        var open = new TaskCompletionSource();
        open.SetResult();
        return open;
    }
}
