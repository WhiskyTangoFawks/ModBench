using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class ProjectionSequenceTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly LoadOrderEntry _partner;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly PluginAddress _baseKey;
    private readonly FormKey _npc1;
    private readonly FormKey _npc2;
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public ProjectionSequenceTests()
    {
        FormKey fk1 = default, fk2 = default;
        _fixture = new PluginFixtureBuilder("projection-sequence")
            .WithPlugin("Base.esm", mod =>
            {
                fk1 = mod.Npcs.AddNew("First").FormKey;
                fk2 = mod.Npcs.AddNew("Second").FormKey;
            }, origin: "BaseMod")
            .WithPlugin("Partner.esp", mod => mod.Npcs.AddNew("PartnerNpc"), origin: "PartnerMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _baseKey = _base.KeyOf();
        _npc1 = fk1;
        _npc2 = fk2;
        _index = Indexes.Open(_holder, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile(IReadOnlyList<LoadOrderEntry> plugins) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4);

    [Fact]
    public void FreshIndex_SequenceIsZero() => Assert.Equal(0, _index.Sequence);

    [Fact]
    public void Reconcile_Ingest_AdvancesTheSequence()
    {
        Reconcile([]);
        var before = _index.Sequence;

        Reconcile(_fixture.Plugins);

        Assert.True(_index.Sequence > before);
    }

    [Fact]
    public void Reconcile_ARegistrationMove_AdvancesTheSequence()
    {
        Reconcile(_fixture.Plugins);
        var before = _index.Sequence;

        Reconcile([.. _fixture.Plugins.Select(p => p with { Enabled = false })]);

        Assert.True(_index.Sequence > before);
    }

    [Fact]
    public void Reconcile_APluginLeaving_AdvancesTheSequence()
    {
        Reconcile(_fixture.Plugins);
        var before = _index.Sequence;

        Reconcile([]);

        Assert.True(_index.Sequence > before);
    }

    [Fact]
    public void Validate_TwoChangedDocuments_AdvanceTheSequenceOnce()
    {
        Reconcile(_fixture.Plugins);
        var reads = _index.RequireReads();
        var formKey1 = _npc1.ToString();
        var formKey2 = _npc2.ToString();
        var document1 = reads.DocumentOf(formKey1, _baseKey);
        var document2 = reads.DocumentOf(formKey2, _baseKey);
        var repository = TrackedMods.RepositoryOf(_base);
        repository.Put(_baseKey, new SourceAdapter.SourceDocument(
            formKey1, document1.RecordType, document1.EditorId, document1.BodyOf().Replace("First", "FirstEdited", StringComparison.Ordinal)));
        repository.Put(_baseKey, new SourceAdapter.SourceDocument(
            formKey2, document2.RecordType, document2.EditorId, document2.BodyOf().Replace("Second", "SecondEdited", StringComparison.Ordinal)));

        var before = _index.Sequence;
        _index.NextSnapshot();

        Assert.Equal(before + 1, _index.Sequence);
        Assert.Equal("FirstEdited", reads.DocumentOf(formKey1, _baseKey).EditorId);
        Assert.Equal("SecondEdited", reads.DocumentOf(formKey2, _baseKey).EditorId);
    }

    [Fact]
    public void Validate_WithUnchangedBytes_AnnouncesNothingOfThePlugin()
    {
        Reconcile(_fixture.Plugins);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index.RequireReads()));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc1.ToString()));
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc2.ToString()));
    }
}
