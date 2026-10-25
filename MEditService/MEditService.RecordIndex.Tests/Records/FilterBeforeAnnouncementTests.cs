using System.Collections.Concurrent;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class FilterBeforeAnnouncementTests : IDisposable
{
    private const string Resident = "Resident.esp";
    private const string Arriving = "Arriving.esp";
    private const string CompiledPlugin = "CompiledPlugin.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly string _compiledPluginNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ConcurrentQueue<int> _listed = new();
    private Predicate<INotification> _announces = _ => false;
    private readonly ILoggerFactory _loggers;
    private readonly OpenedIndex _index;
    private string? _failingAt;
    private volatile bool _failed;

    public FilterBeforeAnnouncementTests()
    {
        var compiledPluginNpc = "";
        _fixture = new PluginFixtureBuilder("filter-before-announcement")
            .WithPlugin(Resident, mod => mod.Npcs.AddNew("ResidentNpc"))
            .WithPlugin(CompiledPlugin, mod => compiledPluginNpc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey.ToString(), origin: "SourceMod")
            .WithPlugin(Arriving, mod => mod.Npcs.AddNew("ArrivingNpc"))
            .BuildScattered();
        _compiledPluginNpc = compiledPluginNpc;
        SourceMods.Init(Entry(CompiledPlugin));
        _loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (_failingAt is not { } logged || !entry.Message.StartsWith(logged, StringComparison.Ordinal)) return;
            _failed = true;
            throw new IOException($"failed at \"{logged}\"");
        })));
        _index = Indexes.Open(_holder, loggerFactory: _loggers, notifications: _notifications);
        _notifications.OnPublish = ListNpcsWhenAnnounced;
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggers.Dispose();
        _fixture.Dispose();
    }

    private void ListNpcsWhenAnnounced(INotification notification)
    {
        if (_announces(notification))
            _listed.Enqueue(_index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Total);
    }

    private LoadOrderEntry Entry(string name) => _fixture.Plugins.Single(p => p.Name == name);

    private void Reconcile(params string[] names) =>
        _index.Reconcile(_holder, _fixture.DataFolder, [.. _fixture.Plugins.Where(p => names.Contains(p.Name))], GameRelease.Fallout4);

    private void CompiledPluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter()
    {
        Reconcile(Resident, CompiledPlugin);
        var document = _index.DocumentOf(_compiledPluginNpc, Entry(CompiledPlugin).Key);
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'EditedWhileAway'", "filter.sql");
        Reconcile(Resident);
        Entry(CompiledPlugin).HandEdit(document, "\"CompiledPluginNpc\"", "\"EditedWhileAway\"");
        _announces = n => n is RowsChangedNotification rows && rows.Keys.Contains(_compiledPluginNpc);
    }

    private void AssertEveryAnnouncementFoundTheOneMatch()
    {
        Assert.NotEmpty(_listed);
        Assert.All(_listed, listed => Assert.Equal(1, listed));
    }

    [Fact]
    public void AnArrivingPlugin_IsAnnouncedAsIndexed_OnlyOnceTheRecordFilterHoldsItsMatches()
    {
        Reconcile(Resident);
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'ArrivingNpc'", "filter.sql");
        var arriving = Entry(Arriving).Key;
        _announces = n =>
            n is LoadOrderStatusNotification status && status.Status.IndexedPlugins.Contains(arriving, PluginAddress.Comparer);

        Reconcile(Resident, Arriving);

        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void ACompiledPluginEditedWhileOutOfTheLoadOrder_AnnouncesItsRowsOnReturn_OnlyOnceTheRecordFilterHoldsThem()
    {
        CompiledPluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter();

        Reconcile(Resident, CompiledPlugin);

        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void ARefreshThatLandsBeforeItsPluginsReadFails_IsAnnouncedOnlyOnceTheRecordFilterHoldsIt()
    {
        CompiledPluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter();
        _failingAt = $"Registering {CompiledPlugin}";

        Reconcile(Resident, CompiledPlugin);

        Assert.True(_failed);
        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void AWinnerSweepThatFails_StillLeavesTheRecordFilterHoldingThePluginItAnnounces()
    {
        Reconcile(Resident, CompiledPlugin);
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedOnDisk'", "filter.sql");
        var resident = Entry(Resident);
        var renamed = new Fallout4Mod(ModKey.FromFileName(Resident), Fallout4Release.Fallout4);
        renamed.Npcs.AddNew("RenamedOnDisk");
        renamed.WriteToBinary(resident.Path);
        _announces = n => n is PluginChangedNotification changed && changed.Plugin.Equals(resident.Key);
        _failingAt = "Swept winners";

        _index.NextSnapshotUnsettledUntil(() => !_listed.IsEmpty, "the plugin's announcement");

        Assert.True(_failed);
        AssertEveryAnnouncementFoundTheOneMatch();
    }
}
