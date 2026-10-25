using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class CompiledPluginProjectionTests : IDisposable
{
    private const string NpcEditorId = "FixtureNpc";
    private const string OtherNpcEditorId = "UntouchedNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly List<(long Sequence, string? EditorId)> _seenWhenPublished = [];
    private readonly OpenedIndex _index;
    private readonly string _npc;
    private readonly string _otherNpc;

    public CompiledPluginProjectionTests()
    {
        FormKey npc = default, otherNpc = default;
        _fixture = new PluginFixtureBuilder("compiled-plugin-projection")
            .WithPlugin("Fixture.esp", mod =>
            {
                npc = mod.Npcs.AddNew(NpcEditorId).FormKey;
                otherNpc = mod.Npcs.AddNew(OtherNpcEditorId).FormKey;
            }, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        _mod = _fixture.Plugins.Single();
        (_npc, _otherNpc) = (npc.ToString(), otherNpc.ToString());
        _notifications.OnPublish = n =>
        {
            if (n is RowsChangedNotification) SeenNow();
        };
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void SeenNow() =>
        _seenWhenPublished.Add((_index.Sequence, _index.CopyIn(_npc, _mod.Key)?.EditorId));

    private void RenameByHand(string formKey, string from, string to) =>
        _mod.HandEdit(_index.DocumentOf(formKey, _mod.Key), $"\"{from}\"", $"\"{to}\"");

    private void ReDeriveRenamed(string formKey, string from, string to)
    {
        RenameByHand(formKey, from, to);
        PluginBinaries.Touch(_mod.Path);
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUntil(
            () => _notifications.Since(before).Any(n => Announcements.RowsChanged(formKey)(n)), "the rows changed announcement");
    }

    [Fact]
    public void ARowsChangedNotification_IsPublishedOnceItsRowsLanded_AndNamesTheSequenceItLandedOn()
    {
        ReDeriveRenamed(_npc, NpcEditorId, "RenamedByHand");

        var landed = _notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(_npc, landed.Keys);
        Assert.Equal(_index.Sequence, landed.Sequence);
        Assert.Equal("RenamedByHand", _seenWhenPublished.Single().EditorId);
        Assert.Equal(landed.Sequence, _seenWhenPublished.Single().Sequence);
    }

    [Fact]
    public void TwoReDerivations_EachLandsItsOwnAdvance_AndEachIsAnnouncedAtTheSequenceItLandedOn()
    {
        var before = _index.Sequence;
        ReDeriveRenamed(_npc, NpcEditorId, "RenamedByHand");
        ReDeriveRenamed(_otherNpc, OtherNpcEditorId, "AlsoRenamedByHand");

        Assert.Equal(before + 2, _index.Sequence);
        var announced = _notifications.Notifications.OfType<RowsChangedNotification>().Select(n => n.Sequence);
        Assert.Equal([before + 1, before + 2], announced);
    }
}
