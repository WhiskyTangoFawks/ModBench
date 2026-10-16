using System.Collections.Concurrent;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class FilterBeforeAnnouncementTests : IDisposable
{
    private const string Resident = "Resident.esp";
    private const string Arriving = "Arriving.esp";
    private const string SourcePlugin = "SourcePlugin.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly string _sourcePluginNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ConcurrentQueue<int> _listed = new();
    private Predicate<INotification> _announces = _ => false;
    private readonly ILoggerFactory _loggers;
    private readonly OpenedIndex _index;
    private string? _failingAt;

    public FilterBeforeAnnouncementTests()
    {
        var sourcePluginNpc = "";
        _fixture = new PluginFixtureBuilder("filter-before-announcement")
            .WithPlugin(Resident, mod => mod.Npcs.AddNew("ResidentNpc"))
            .WithPlugin(SourcePlugin, mod => sourcePluginNpc = mod.Npcs.AddNew("SourcePluginNpc").FormKey.ToString(), origin: "SourceMod")
            .WithPlugin(Arriving, mod => mod.Npcs.AddNew("ArrivingNpc"))
            .BuildScattered();
        _sourcePluginNpc = sourcePluginNpc;
        SourceMods.Track(Entry(SourcePlugin));
        _loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (_failingAt is { } logged && entry.Message.StartsWith(logged, StringComparison.Ordinal))
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
        _index.Reconcile(_holder, _fixture.GameDirectory, [.. _fixture.Plugins.Where(p => names.Contains(p.Name))], GameRelease.Fallout4);

    private void SourcePluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter()
    {
        Reconcile(Resident, SourcePlugin);
        var document = _index.DocumentOf(_sourcePluginNpc, Entry(SourcePlugin).KeyOf());
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'EditedWhileAway'", "filter.sql");
        Reconcile(Resident);
        Entry(SourcePlugin).HandEdit(document, "\"SourcePluginNpc\"", "\"EditedWhileAway\"");
        _announces = n => n is RowsChangedNotification rows && rows.Keys.Contains(_sourcePluginNpc);
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
        var arriving = Entry(Arriving).KeyOf();
        _announces = n =>
            n is LoadOrderStatusNotification status && status.Status.IndexedPlugins.Contains(arriving, PluginAddress.Comparer);

        Reconcile(Resident, Arriving);

        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void ASourcePluginEditedWhileOutOfTheLoadOrder_AnnouncesItsRowsOnReturn_OnlyOnceTheRecordFilterHoldsThem()
    {
        SourcePluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter();

        Reconcile(Resident, SourcePlugin);

        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void ARefreshThatLandsBeforeItsPluginsReadFails_IsAnnouncedOnlyOnceTheRecordFilterHoldsIt()
    {
        SourcePluginNpcEditedWhileOutOfTheLoadOrder_ToMatchTheFilter();
        _failingAt = $"Registering {SourcePlugin}";

        Reconcile(Resident, SourcePlugin);

        AssertEveryAnnouncementFoundTheOneMatch();
    }

    [Fact]
    public void AWinnerSweepThatFails_StillLeavesTheRecordFilterHoldingThePluginItAnnounces()
    {
        Reconcile(Resident, SourcePlugin);
        _index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedOnDisk'", "filter.sql");
        var resident = Entry(Resident);
        var renamed = new Fallout4Mod(ModKey.FromFileName(Resident), Fallout4Release.Fallout4);
        renamed.Npcs.AddNew("RenamedOnDisk");
        renamed.WriteToBinary(resident.Path);
        _announces = n => n is PluginChangedNotification changed && changed.Plugin.Equals(resident.KeyOf());
        _failingAt = "Swept winners";

        _index.NextSnapshotUnsettledUntil(() => !_listed.IsEmpty, "the plugin's announcement");

        AssertEveryAnnouncementFoundTheOneMatch();
    }
}
