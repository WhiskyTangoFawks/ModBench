using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

// ADR-0012 invariant 1: a key that differs only in case names the same plugin at every door, the
// opened plugins, the held-plugins lookup and the store's rows alike.
public sealed class PluginAddressComparisonTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("plugin-address-comparison")
        .WithPlugin("Cased.esp", mod => mod.Npcs.AddNew("FromCased"), origin: "CasedMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly Indexer _index;

    public PluginAddressComparisonTests()
    {
        _index = Indexes.Open(_holder, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginAddress OtherCase = new("CASED.ESP", "casedmod");

    // The rival this pins: the record struct's own equality, which is case-sensitive.
    [Fact]
    public void TheOpenedPlugins_AnswerTheSamePlugin_WhateverTheCase()
    {
        Assert.True(_index.RequireReads().OpenedPlugins.ContainsKey(OtherCase));
    }

    [Fact]
    public void AReadUnderAnotherCase_AnswersThePluginsRows()
    {
        var reads = _index.RequireReads();

        Assert.Equal(
            reads.GetDocuments(_fixture.Plugins.Single().KeyOf()).Select(d => d.FormKey).Order(),
            reads.GetDocuments(OtherCase).Select(d => d.FormKey).Order());
    }

    // Mutagen's ModKey compares ignoring case, so a FormKey whose filename differs only in case
    // names the same record.
    private string NpcUnderAnotherCase() =>
        _index.RequireReads().GetDocuments(_fixture.Plugins.Single().KeyOf())
            .Single(d => d.EditorId == "FromCased").FormKey.ToUpperInvariant();

    [Fact]
    public void APointReadUnderAnotherCase_AnswersTheRecord()
    {
        Assert.Equal("FromCased", _index.RequireReads().GetDocument(NpcUnderAnotherCase())?.EditorId);
    }

    [Fact]
    public void AnOverrideStackUnderAnotherCase_HoldsThePluginsCopy()
    {
        var stack = _index.RequireReads().GetOverrideStack(NpcUnderAnotherCase());

        Assert.NotNull(stack);
        Assert.Single(stack.Entries);
    }

    [Fact]
    public void ASearchFilteredUnderAnotherCase_FindsThePluginsRecords()
    {
        var query = new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginName(OtherCase.Name), Origin: OtherCase.Origin);

        Assert.Equal(1, _index.RequireReads().Search(query).Total);
    }

    // The file's rows outlive the index that wrote them, so the next one meets them under whatever
    // case its load order names the plugin in.
    [Fact]
    public void AnIndexReopenedUnderAnotherCase_HoldsOneCopyOfItsRecord()
    {
        var entry = _fixture.Plugins.Single();
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot).Dispose();

        using var reopened = Indexes.Reconciled(_fixture.GameDirectory,
            [entry with { Name = OtherCase.Name, Origin = OtherCase.Origin }], _fixture.InstanceRoot);

        Assert.Equal(1, reopened.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"])).Total);
    }

    // The rival this pins: a held-plugins lookup comparing name and origin its own way, which would
    // miss the plugin the gone report names, unindex nothing and still announce a change.
    [Fact]
    public async Task AGoneReportUnderAnotherCase_FindsTheHeldPluginStillOnDisk_AndAnnouncesNothing()
    {
        var entry = _fixture.Plugins.Single();
        var published = _notifications.Notifications.Count;

        await _index.RefreshBinary(OtherCase, Path.Combine(_fixture.GameDirectory, "a-superseded-path", entry.Name));

        Assert.NotEmpty(_index.RequireReads().GetDocuments(entry.KeyOf()));
        Assert.Empty(_notifications.Notifications.Skip(published).OfType<PluginChangedNotification>());
    }
}
