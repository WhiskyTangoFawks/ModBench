using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>The same seam over a tracked mod: what the sequence and the rows-changed port answer
/// while the projections that move a working tree are in flight.</summary>
public sealed class TrackedProjectionTests : IDisposable
{
    private const string NpcEditorId = "FixtureNpc";
    private const string OtherNpcEditorId = "UntouchedNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly Indexer _index;
    private readonly string _npc;
    private readonly string _otherNpc;

    public TrackedProjectionTests()
    {
        FormKey npc = default, otherNpc = default;
        _fixture = new PluginFixtureBuilder("tracked-projection")
            .WithPlugin("Fixture.esp", mod =>
            {
                npc = mod.Npcs.AddNew(NpcEditorId).FormKey;
                otherNpc = mod.Npcs.AddNew(OtherNpcEditorId).FormKey;
            }, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        (_npc, _otherNpc) = (npc.ToString(), otherNpc.ToString());
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void RenameByHand(string formKey, string from, string to) =>
        _mod.HandEdit(_index.RequireReads().DocumentOf(formKey, _mod.KeyOf()), $"\"{from}\"", $"\"{to}\"");

    [Fact]
    public async Task ATrackedPluginReDerivedFromADirtyTree_AdvancesTheSequenceExactlyOnce()
    {
        // Dirty, so the head reconcile has baselines to write: a clean tree short-circuits it and
        // would leave the multi-advance case untested.
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");
        PluginBinaries.Touch(_mod.Path);
        var before = _index.Sequence;

        Assert.True(await _index.RefreshBinary(_mod.KeyOf(), _mod.Path));

        Assert.Equal(before + 1, _index.Sequence);
    }

    [Fact]
    public void ARowsChangedNotification_WaitsForItsProjectionToLand_AndNamesTheSequenceItLandedOn()
    {
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");

        using (_index.BeginProjection())
        {
            _index.RefreshKeys(_mod.KeyOf(), [_npc]);
            Assert.Empty(_notifications.Notifications.OfType<RowsChangedNotification>());
        }

        var landed = _notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(_npc, landed.Keys);
        Assert.Equal(_index.Sequence, landed.Sequence);
    }

    [Fact]
    public async Task TwoProjectionsOpenAtOnce_EachLandsItsOwnAdvance_AndNothingIsAnnouncedAheadOfTheStore()
    {
        RenameByHand(_npc, NpcEditorId, "RenamedByHand");
        RenameByHand(_otherNpc, OtherNpcEditorId, "AlsoRenamedByHand");
        var before = _index.Sequence;
        var announced = new ConcurrentBag<long>();

        // The two projections overlap without nesting — the first opens before the second and closes
        // before it — while every store call stays strictly ordered, since one connection is one
        // writer.
        using var firstOpen = new ManualResetEventSlim();
        using var secondOpen = new ManualResetEventSlim();
        using var firstClosed = new ManualResetEventSlim();

        var first = Task.Run(() =>
        {
            using (_index.BeginProjection())
            {
                _index.RefreshKeys(_mod.KeyOf(), [_npc]);
                _index.Announce(() => announced.Add(_index.Sequence));
                firstOpen.Set();
                Wait(secondOpen);
            }
            firstClosed.Set();
        });

        var second = Task.Run(() =>
        {
            Wait(firstOpen);
            using (_index.BeginProjection())
            {
                _index.RefreshKeys(_mod.KeyOf(), [_otherNpc]);
                _index.Announce(() => announced.Add(_index.Sequence));
                secondOpen.Set();
                Wait(firstClosed);
            }
        });

        await Task.WhenAll(first, second);

        Assert.Equal(before + 2, _index.Sequence);
        Assert.Equal(2, announced.Count);
        Assert.All(announced, sequence => Assert.InRange(sequence, before + 1, _index.Sequence));
    }

    private static void Wait(ManualResetEventSlim gate)
    {
        if (!gate.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The other projection never got there.");
    }
}
