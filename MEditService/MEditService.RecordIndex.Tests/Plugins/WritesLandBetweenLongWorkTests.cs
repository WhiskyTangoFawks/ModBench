using MEditService.LoadOrder;
using MEditService.Ports;
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
    private const string Invalidating = "Invalidating.esp";
    private const string Arriving = "Arriving.esp";
    private const string ArrivingNext = "ArrivingNext.esp";
    private static readonly TimeSpan WellInsideThePark = TimeSpan.FromSeconds(10);

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly GatedPluginAdapter _adapter = new();
    private readonly LoadOrderHolder _holder = new();
    private readonly LeapingClock _clock = new();
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("writes-land-between")
        .WithPlugin(Written, mod => mod.Npcs.AddNew("WrittenNpc"), origin: "WrittenMod")
        .WithPlugin(First, mod => mod.Npcs.AddNew("FirstNpc"), origin: "FirstMod")
        .WithPlugin(Second, mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
        .WithPlugin(PutBack, mod => mod.Npcs.AddNew("PutBackNpc"), origin: "PutBackMod")
        .WithPlugin(Invalidating, mod => mod.Npcs.AddNew("InvalidatingNpc"), origin: "InvalidatingMod")
        .BuildScattered();
    private readonly OpenedIndex _index;

    public WritesLandBetweenLongWorkTests()
    {
        _index = Indexes.Open(
            _holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Invalidating, nthRead: 2, _adapter),
            notifications: _notifications, timeProvider: _clock);
        _index.Receive(_holder, Snapshot());
    }

    public void Dispose()
    {
        _clock.StopLeaping();
        _index.Dispose();
        _adapter.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin(string name) => _fixture.Plugins.Single(plugin => plugin.Name == name);

    private LoadOrderSnapshot Snapshot(params LoadOrderEntry[] plugins) =>
        SnapshotPlugins.Snapshot(_fixture.DataFolder, _fixture.InstanceRoot, GameRelease.Fallout4, plugins.Length > 0 ? plugins : _fixture.Plugins);

    private async Task<Task<string?>> ACheckParkedAt(string plugin)
    {
        PluginBinaries.Touch(Plugin(First).Path);
        PluginBinaries.Touch(Plugin(Second).Path);
        _adapter.ParkNextOpenOf(plugin);
        var check = _index.Queries.Hold(null, CancellationToken.None);
        await _adapter.WaitUntilParkedAsync();
        return check;
    }

    private async Task<long> AReconcileParkedAt(string plugin, params LoadOrderEntry[] plugins)
    {
        _adapter.ParkNextOpenOf(plugin);
        var version = _holder.Apply(Snapshot(plugins));
        await _adapter.WaitUntilParkedAsync();
        return version;
    }

    private LoadOrderEntry NewPlugin(string name, int line)
    {
        var path = Path.Combine(_fixture.DataFolder, name);
        PluginBinaries.Rewrite(path, mod => mod.Npcs.AddNew($"{Path.GetFileNameWithoutExtension(name)}Npc"));
        return new LoadOrderEntry(name, path, PluginOrigin.DataDirectory, line, Enabled: true, Winning: true);
    }

    private Task<string?> Rewrite(string plugin, string editorId)
    {
        PluginBinaries.Rewrite(Plugin(plugin).Path, mod => mod.Npcs.AddNew(editorId));
        return HandWriteOf(Plugin(plugin).Key);
    }

    private Task<string?> HandWriteOf(params PluginAddress[] plugins) =>
        _index.Queries.Hold([.. plugins.Select(HandedPlugin.ReadBack)], CancellationToken.None);

    private async Task MovedOnTo(string plugin)
    {
        _adapter.ParkNextOpenOf(plugin);
        _adapter.Release();
        await _adapter.WaitUntilParkedAsync();
    }

    private IEnumerable<string?> Listed(string plugin) => _index.ListedIn(Plugin(plugin).Key).Select(row => row.EditorId);

    private long AnnouncedAt(int since, string plugin) =>
        _notifications.Since(since).OfType<PluginChangedNotification>().Single(changed => PluginAddress.Comparer.Equals(changed.Plugin, Plugin(plugin).Key)).Sequence;

    [Fact]
    public async Task ACheck_LandsThePluginsItValidatesWithinTheTimeTogether()
    {
        PluginBinaries.Touch(Plugin(First).Path);
        PluginBinaries.Touch(Plugin(Second).Path);
        var before = _notifications.Notifications.Count;

        Assert.Null(await _index.Queries.Hold(null, CancellationToken.None).WaitAsync(WellInsideThePark));

        Assert.Equal(AnnouncedAt(before, First), AnnouncedAt(before, Second));
    }

    [Fact]
    public async Task ACheckPastTheTimePluginsLandTogether_AnnouncesEachPluginAsItLands()
    {
        _clock.StartLeaping();
        var before = _notifications.Notifications.Count;
        var check = await ACheckParkedAt(Second);

        Assert.Contains(_notifications.Since(before), PluginChanged(Plugin(First)));
        _adapter.Release();
        Assert.Null(await check.WaitAsync(WellInsideThePark));
    }

    [Fact]
    public async Task AWriteNamingTwoPlugins_LandsInOneCommit()
    {
        PluginBinaries.Rewrite(Plugin(Written).Path, mod => mod.Npcs.AddNew("Rewritten"));
        PluginBinaries.Rewrite(Plugin(PutBack).Path, mod => mod.Npcs.AddNew("Rewritten"));
        var before = _notifications.Notifications.Count;

        Assert.Null(await HandWriteOf(Plugin(Written).Key, Plugin(PutBack).Key).WaitAsync(WellInsideThePark));

        Assert.Equal(AnnouncedAt(before, Written), AnnouncedAt(before, PutBack));
    }

    [Fact]
    public async Task AFilePutBackAfterAWriteLandedDuringACheck_IsReadAsPutBack()
    {
        _clock.StartLeaping();
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
    public async Task ACheckBeneathWhichAWriteReopenedTheIndexFile_StopsWithTheWritesCause_AndTheNextCheckReadsEveryPlugin()
    {
        _clock.StartLeaping();
        var check = await ACheckParkedAt(First);
        var write = Rewrite(Invalidating, "Rewritten");

        _adapter.Release();

        var unread = await write.WaitAsync(WellInsideThePark);
        Assert.StartsWith("mEdit's record index has not read", unread, StringComparison.Ordinal);
        Assert.Equal(unread, await check.WaitAsync(WellInsideThePark));
        Assert.Null(await _index.Queries.Hold(null, CancellationToken.None).WaitAsync(WellInsideThePark));
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
        Assert.Empty(_index.Status.Failures);
        Assert.Equal(["Rewritten"], Listed(Invalidating));
    }

    [Fact]
    public async Task AWriteHandedWhileANewerLoadOrderWaits_IsHeldAgainstThatLoadOrder()
    {
        _clock.StartLeaping();
        var check = await ACheckParkedAt(First);
        var arriving = NewPlugin(Arriving, 10);
        var version = _holder.Apply(Snapshot([.. _fixture.Plugins, arriving]));
        var write = HandWriteOf(arriving.Key);

        _adapter.Release();

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.Null(await check.WaitAsync(WellInsideThePark));
        _index.AwaitVersion(version);
    }

    [Fact]
    public async Task AWriteHandedAfterOneNamingAPluginThatFailedToOpen_StillLandsBetweenTheChecksPlugins()
    {
        var unopenable = Path.Combine(_fixture.DataFolder, "Unopenable.esp");
        File.WriteAllText(unopenable, "not a plugin");
        var failing = new LoadOrderEntry("Unopenable.esp", unopenable, PluginOrigin.DataDirectory, 10, Enabled: true, Winning: true);
        _index.Receive(_holder, Snapshot([.. _fixture.Plugins, failing]));
        _clock.StartLeaping();
        PluginBinaries.Touch(Plugin(PutBack).Path);
        var check = await ACheckParkedAt(First);
        var naming = HandWriteOf(failing.Key);
        await MovedOnTo(Second);
        await naming.WaitAsync(WellInsideThePark);
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(PutBack);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        _adapter.Release();
        await check.WaitAsync(WellInsideThePark);
    }

    [Fact]
    public async Task AWriteHandedDuringAReconcile_IsHeldBeforeTheReconcileReadsItsNextArrival()
    {
        var version = await AReconcileParkedAt(Arriving, [.. _fixture.Plugins, NewPlugin(Arriving, 10), NewPlugin(ArrivingNext, 11)]);
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(ArrivingNext);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.Contains("Rewritten", Listed(Written));
        _adapter.Release();
        _index.AwaitVersion(version);
    }

    [Fact]
    public async Task AWriteNamingAPluginTheReconcileIsStillToLand_IsHeldOnceItLands_AndHoldsBackNoOtherWrite()
    {
        var version = await AReconcileParkedAt(Arriving, [.. _fixture.Plugins, NewPlugin(Arriving, 10), NewPlugin(ArrivingNext, 11)]);
        var waiting = HandWriteOf(new PluginAddress(ArrivingNext, PluginOrigin.DataDirectory));
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(ArrivingNext);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        Assert.False(waiting.IsCompleted);
        _adapter.Release();
        Assert.Null(await waiting.WaitAsync(WellInsideThePark));
        _index.AwaitVersion(version);
    }

    [Fact]
    public async Task AWriteHandedWhileAReconcileReadsPluginsAgainForTheirStrings_IsHeldBeforeItReadsTheNext()
    {
        var version = await AReconcileParkedAt(First, [.. _fixture.Plugins.Select(plugin => plugin.Name is First or Second ? StringsHandedAnew(plugin) : plugin)]);
        var write = Rewrite(Written, "Rewritten");

        await MovedOnTo(Second);

        Assert.Null(await write.WaitAsync(WellInsideThePark));
        _adapter.Release();
        _index.AwaitVersion(version);
    }

    private static LoadOrderEntry StringsHandedAnew(LoadOrderEntry plugin) => plugin with
    {
        NamedStrings = new PluginStrings([], [new StampedFile(
            Path.Combine(Path.GetDirectoryName(plugin.Path).Require(), "Strings", $"{Path.GetFileNameWithoutExtension(plugin.Path)}_en.strings"), "handed anew")]),
    };
}
