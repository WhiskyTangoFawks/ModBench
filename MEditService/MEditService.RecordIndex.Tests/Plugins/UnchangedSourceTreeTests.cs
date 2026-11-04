using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class UnchangedSourceTreeTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _plugin;
    private readonly LoadOrderEntry _marker;
    private readonly string _npc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly CountingTreeSource _source;
    private readonly OpenedIndex _index;

    public UnchangedSourceTreeTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("unchanged-source-tree")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("Original").FormKey, origin: "BaseMod")
            .WithPlugin("Marker.esp", mod => mod.Npcs.AddNew("Marker"), origin: "MarkerMod")
            .BuildScattered();
        _plugin = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _marker = _fixture.Plugins.Single(p => p.Name == "Marker.esp");
        SourceMods.Init(_plugin);
        _npc = npc.ToString();
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _source = new CountingTreeSource(TestAdapters.Source(clock));
        _index = Indexes.Open(_holder, notifications: _notifications, timeProvider: clock, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Arrive()
    {
        var announced = Touched(_marker);
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUntil(() => _notifications.Since(before).Any(n => announced(n)), "the arrival validated");
    }

    private WorkingTreeState StateOfNpc() =>
        _index.Queries.GetRecords(["npc_"], _plugin.Key, search: null, limit: 50, offset: 0).Value().Items.Single(i => i.FormKey == _npc).WorkingTreeState;

    private void EditNpc() =>
        _index.Edit(_plugin, _index.DocumentOf(_npc, _plugin.Key), _index.BodyOf(_npc, _plugin.Key).Replace("Original", "Edited", StringComparison.Ordinal));

    [Fact]
    public void ATreeWhoseDocumentsAndRepositoryStandAsTheyWere_IsNotAskedWhatChangedSinceItsLastCommit()
    {
        Arrive();
        var asked = _source.GitStatusAsked;

        Arrive();
        Arrive();

        Assert.Equal(asked, _source.GitStatusAsked);
    }

    [Fact]
    public void ATreeCommittedOutsideModbench_WithNoDocumentTouched_IsListedUnchanged()
    {
        EditNpc();
        Arrive();
        Arrive();
        Assert.Equal(WorkingTreeState.Modified, StateOfNpc());

        _plugin.Git("add", "-A");
        _plugin.Git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "outside");
        Arrive();

        Assert.Equal(WorkingTreeState.None, StateOfNpc());
    }

    [Fact]
    public void ATreeWhoseDocumentIsEditedOutsideModbench_IsAskedAgain()
    {
        Arrive();
        Arrive();
        var asked = _source.GitStatusAsked;

        EditNpc();
        Arrive();

        Assert.True(_source.GitStatusAsked > asked);
    }
}
