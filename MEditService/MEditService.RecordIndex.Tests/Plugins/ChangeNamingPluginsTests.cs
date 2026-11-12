using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ChangeNamingPluginsTests : IDisposable
{
    private readonly PluginFixtureData _fixture;
    private readonly LoadOrderEntry _named;
    private readonly LoadOrderEntry _unnamed;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public ChangeNamingPluginsTests()
    {
        _fixture = new PluginFixtureBuilder("change-naming-plugins").WithPlugin("Named.esp").WithPlugin("Unnamed.esp").Build();
        _named = _fixture.Plugins.Single(p => p.Name == "Named.esp");
        _unnamed = _fixture.Plugins.Single(p => p.Name == "Unnamed.esp");
        _index = Indexes.Open(_holder, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void SignalNamingUntil(Predicate<INotification> announced, params LoadOrderEntry[] plugins)
    {
        var before = _notifications.Notifications.Count;
        _index.SignalChange([.. plugins.Select(plugin => plugin.Key)]);
        Waits.Reached(() => _notifications.Since(before).Any(n => announced(n)), "the re-read's announcement");
    }

    [Fact]
    public void AChangeNamingAPlugin_ReReadsThatPlugin_AndNoOther()
    {
        PluginBinaries.Touch(_unnamed.Path);

        SignalNamingUntil(Touched(_named), _named);
        _index.Settled();

        Assert.Equal(PluginIndexing.NotYet, _index.Queries.GetPluginIndexedAsOnDisk(_unnamed.Key).Value().State);
        Assert.Equal(PluginIndexing.AsOnDisk, _index.Queries.GetPluginIndexedAsOnDisk(_named.Key).Value().State);
    }

    [Fact]
    public void APluginARefreshCouldNotOpen_IsOpenedByAChangeNamingIt_OnceItsBytesAreRestored()
    {
        var bytes = File.ReadAllBytes(_named.Path);
        File.WriteAllText(_named.Path, "not a plugin");
        SignalNamingUntil(_ => _index.Status.Failures.Any(f => f.Name == _named.Name), _named);
        Assert.Null(_index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot));
        Waits.Reached(() => _index.Status is { State: LoadOrderState.Ready } status && status.Failures.Any(f => f.Name == _named.Name), "the refresh's failure");

        File.WriteAllBytes(_named.Path, bytes);
        _index.SignalChange([_named.Key]);

        Waits.Reached(() => _index.Status is { State: LoadOrderState.Ready, Failures: [] }, "the restored plugin read");
    }
}
