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

    private readonly HeldPublisher _notifications = new();
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly ScratchDirectory _gameDirectory = new("medit-trail-game-");
    private readonly ScratchDirectory _instanceRoot = new("medit-trail-instance-");
    private readonly string _pluginPath;

    public SequenceTrailsAnnouncementTests()
    {
        _index = Indexes.Open(_holder, notifications: _notifications);
        var modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        _pluginPath = Path.Combine(modFolder, PluginName);
    }

    public void Dispose()
    {
        _notifications.Release();
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
        _notifications.HoldPluginChanged();

        PluginBinaries.Touch(_pluginPath);
        _holder.Apply(_holder.Current);
        Waits.Reached(() => _notifications.Holding, "the re-derive's announcement being published");
        var read = Task.Run(() => _index.Sequence);

        Assert.False(await Waits.CompletesWithin(read, TimeSpan.FromMilliseconds(300)));
        _notifications.Release();
        Assert.True(await read > before);
    }

    private sealed class HeldPublisher : INotificationPublisher
    {
        private readonly InMemoryNotificationPublisher _inner = new();
        private volatile TaskCompletionSource _released = Open();
        private volatile bool _holding;

        internal bool Holding => _holding;

        internal void HoldPluginChanged() => _released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        internal void Release() => _released.TrySetResult();

        public void Publish(Notification notification)
        {
            if (notification is PluginChangedNotification)
            {
                _holding = true;
                _released.Task.Wait();
            }
            _inner.Publish(notification);
        }

        private static TaskCompletionSource Open()
        {
            var open = new TaskCompletionSource();
            open.SetResult();
            return open;
        }
    }
}
