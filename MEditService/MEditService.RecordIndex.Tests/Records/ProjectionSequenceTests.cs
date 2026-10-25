using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

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
            .CompiledPlugin();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _baseKey = _base.Key;
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
        _index.Reconcile(_holder, _fixture.DataFolder, plugins, GameRelease.Fallout4);

    [Fact]
    public void FreshIndex_SequenceIsZero() => Assert.Equal(0, _index.Sequence);

    private IReadOnlyList<LoadOrderEntry> LoadOrderOf(string plugins) => new Dictionary<string, IReadOnlyList<LoadOrderEntry>>
    {
        ["none"] = [],
        ["every plugin"] = _fixture.Plugins,
        ["every plugin disabled"] = [.. _fixture.Plugins.Select(p => p with { Enabled = false })],
    }[plugins];

    [Theory]
    [InlineData("none", "every plugin")]
    [InlineData("every plugin", "every plugin disabled")]
    [InlineData("every plugin", "none")]
    public void ALoadOrderThatMovesRows_AdvancesTheSequence(string before, string after)
    {
        Reconcile(LoadOrderOf(before));
        var sequence = _index.Sequence;

        Reconcile(LoadOrderOf(after));

        Assert.True(_index.Sequence > sequence);
    }

    [Fact]
    public void ValidatingTwoChangedDocuments_AdvancesTheSequenceOnce()
    {
        Reconcile(_fixture.Plugins);
        var formKey1 = _npc1.ToString();
        var formKey2 = _npc2.ToString();
        var before = _index.Sequence;

        _index.Project(_base, [
            (formKey1, _index.BodyOf(formKey1, _baseKey).Replace("First", "FirstEdited", StringComparison.Ordinal)),
            (formKey2, _index.BodyOf(formKey2, _baseKey).Replace("Second", "SecondEdited", StringComparison.Ordinal)),
        ]);

        Assert.Equal(before + 1, _index.Sequence);
        Assert.Equal("FirstEdited", _index.DocumentOf(formKey1, _baseKey).EditorId);
        Assert.Equal("SecondEdited", _index.DocumentOf(formKey2, _baseKey).EditorId);
    }

    [Fact]
    public void ValidatingUnchangedBytes_AnnouncesNothingOfThePlugin()
    {
        Reconcile(_fixture.Plugins);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc1.ToString()));
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc2.ToString()));
    }
}
