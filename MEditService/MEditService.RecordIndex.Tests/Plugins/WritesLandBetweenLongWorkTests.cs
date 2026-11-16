using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class WritesLandBetweenLongWorkTests : IDisposable
{
    private const string Written = "Written.esp";
    private const string First = "First.esp";
    private const string Second = "Second.esp";
    private const string PutBack = "PutBack.esp";
    private const string Arriving = "Arriving.esp";
    private const string ArrivingNext = "ArrivingNext.esp";
    private static readonly TimeSpan WellInsideThePark = TimeSpan.FromSeconds(10);

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly GatedPluginAdapter _adapter = new();
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("writes-land-between")
        .WithPlugin(Written, mod => mod.Npcs.AddNew("WrittenNpc"), origin: "WrittenMod")
        .WithPlugin(First, mod => mod.Npcs.AddNew("FirstNpc"), origin: "FirstMod")
        .WithPlugin(Second, mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
        .WithPlugin(PutBack, mod => mod.Npcs.AddNew("PutBackNpc"), origin: "PutBackMod")
        .BuildScattered();
    private readonly OpenedIndex _index;

    public WritesLandBetweenLongWorkTests() => _index = Indexes.Reconciled(_fixture, adapter: _adapter, notifications: _notifications);

    public void Dispose()
    {
        _index.Dispose();
        _adapter.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin(string name) => _fixture.Plugins.Single(plugin => plugin.Name == name);

    private async Task<Task<string?>> ACheckParkedAt(string plugin)
    {
        PluginBinaries.Touch(Plugin(First).Path);
        PluginBinaries.Touch(Plugin(Second).Path);
        _adapter.ParkNextOpenOf(plugin);
        var check = _index.Queries.Hold(null, CancellationToken.None);
        await _adapter.WaitUntilParkedAsync();
        return check;
    }

    private async Task<long> AReconcileParkedAtItsFirstArrival()
    {
        _adapter.ParkNextOpenOf(Arriving);
        var version = _index.Holder.Apply(SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, NewPlugin(Arriving, 10), NewPlugin(ArrivingNext, 11)]));
        await _adapter.WaitUntilParkedAsync();
        return version;
    }

    private LoadOrderEntry NewPlugin(string name, int priority)
    {
        var path = Path.Combine(_fixture.DataFolder, name);
        PluginBinaries.Rewrite(path, mod => mod.Npcs.AddNew($"{Path.GetFileNameWithoutExtension(name)}Npc"));
        return new LoadOrderEntry(name, path, PluginOrigin.DataDirectory, priority, Enabled: true, Winning: true);
    }

    private Task<string?> Rewrite(string plugin, string editorId)
    {
        PluginBinaries.Rewrite(Plugin(plugin).Path, mod => mod.Npcs.AddNew(editorId));
        return HandWriteOf(Plugin(plugin).Key);
    }

    private Task<string?> HandWriteOf(PluginAddress plugin) => _index.Queries.Hold([HandedPlugin.ReadBack(plugin)], CancellationToken.None);

    private async Task MovedOnTo(string plugin)
    {
        _adapter.ParkNextOpenOf(plugin);
        _adapter.Release();
        await _adapter.WaitUntilParkedAsync();
    }

    private IEnumerable<string?> Listed(string plugin) => _index.ListedIn(Plugin(plugin).Key).Select(row => row.EditorId);

    [Fact]
    public async Task AWriteHandedDuringACheck_IsHeldBeforeTheCheckReadsItsNextPlugin()
    {
        var check = await ACheckParkedAt(First);
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(Second);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.Contains("Rewritten", Listed(Written));
        Assert.False(check.IsCompleted);
        _adapter.Release();
        Assert.Null(await check.WaitAsync(WellInsideThePark));
    }

    [Fact]
    public async Task ACheck_AnnouncesEachPluginAsItLands()
    {
        var before = _notifications.Notifications.Count;
        var check = await ACheckParkedAt(Second);

        Assert.Contains(_notifications.Since(before), PluginChanged(Plugin(First)));
        _adapter.Release();
        Assert.Null(await check.WaitAsync(WellInsideThePark));
    }

    [Fact]
    public async Task AFilePutBackAfterAWriteLandedDuringACheck_IsReadAsPutBack()
    {
        var before = File.ReadAllBytes(Plugin(PutBack).Path);
        var check = await ACheckParkedAt(First);
        var write = Rewrite(PutBack, "Rewritten");
        await MovedOnTo(Second);
        Assert.Null(await write.WaitAsync(WellInsideThePark));

        File.WriteAllBytes(Plugin(PutBack).Path, before);
        _adapter.Release();

        Assert.Null(await check.WaitAsync(WellInsideThePark));
        Assert.Equal(["PutBackNpc"], Listed(PutBack));
    }

    [Fact]
    public async Task AWriteHandedWhileANewerLoadOrderWaits_IsHeldAgainstThatLoadOrder()
    {
        var check = await ACheckParkedAt(First);
        var arriving = NewPlugin(Arriving, 10);
        var version = _index.Holder.Apply(SnapshotPlugins.Snapshot(
            _fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, [.. _fixture.Plugins, arriving]));
        var write = HandWriteOf(arriving.Key);

        _adapter.Release();

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.Null(await check.WaitAsync(WellInsideThePark));
        _index.AwaitVersion(version);
    }

    [Fact]
    public async Task AWriteHandedDuringAReconcile_IsHeldBeforeTheReconcileReadsItsNextArrival()
    {
        var version = await AReconcileParkedAtItsFirstArrival();
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(ArrivingNext);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.Contains("Rewritten", Listed(Written));
        _adapter.Release();
        _index.AwaitVersion(version);
    }

    [Fact]
    public async Task AWriteNamingAPluginTheReconcileIsStillToLand_IsHeldOnceItLands()
    {
        var version = await AReconcileParkedAtItsFirstArrival();
        var write = HandWriteOf(new PluginAddress(ArrivingNext, PluginOrigin.DataDirectory));

        _adapter.Release();

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        _index.AwaitVersion(version);
    }
}
