using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class WorkingTreeDeletionTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly LoadOrderEntry _winner;
    private readonly PluginAddress _baseKey;
    private readonly PluginAddress _winnerKey;
    private readonly string _npc;
    private readonly string _raceA;
    private readonly string _raceB;

    public WorkingTreeDeletionTests()
    {
        FormKey npc = default, raceA = default, raceB = default;
        _fixture = new PluginFixtureBuilder("working-tree-deletion")
            .WithPlugin("Base.esm", mod =>
            {
                raceA = mod.Races.AddNew("RaceA").FormKey;
                raceB = mod.Races.AddNew("RaceB").FormKey;
                var n = mod.Npcs.AddNew("TestNpc");
                n.Race.SetTo(raceA);
                npc = n.FormKey;
            }, origin: "BaseMod")
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == npc).DeepCopy());
            }, origin: "WinnerMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _winner = _fixture.Plugins.Single(p => p.Name == "Winner.esp");
        _baseKey = _base.KeyOf();
        _winnerKey = _winner.KeyOf();
        (_npc, _raceA, _raceB) = (npc.ToString(), raceA.ToString(), raceB.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void DeletingARecord_RemovesItFromEffective_AndRestoringItsCommittedBytesConvergesToClean()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_raceA, _baseKey);

        index.Delete(_base, committed);

        Assert.Null(reads.GetDocument(_raceA, _baseKey));
        Assert.Null(reads.GetDocument(_raceA));

        index.Create(_base, _raceA, "race", "RaceA", committed.BodyOf());
        var restored = reads.StackEntry(_raceA, _baseKey);
        Assert.NotNull(restored);
        Assert.False(restored.HasWorkingTreeChange);
    }

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_AtEffective()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var initialWinner = reads.GetDocument(_npc);
        Assert.NotNull(initialWinner);
        Assert.Equal("Winner.esp", initialWinner.Plugin.Name);

        index.Delete(_winner, reads.DocumentOf(_npc, _winnerKey));

        var effectiveWinner = reads.GetDocument(_npc);
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Base.esm", effectiveWinner.Plugin.Name);
        Assert.True(effectiveWinner.IsWinner);
        var stack = reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        Assert.Equal([("Base.esm", true)], stack.Entries.Select(e => (e.Plugin.Name, e.IsWinner)));
    }

    [Fact]
    public void RestoringADeletedOverride_MakesItTheEffectiveWinnerAgain()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var winnersDocument = reads.DocumentOf(_npc, _winnerKey);
        var winnersBody = winnersDocument.BodyOf();

        index.Delete(_winner, winnersDocument);
        var afterDeletion = reads.GetDocument(_npc);
        Assert.NotNull(afterDeletion);
        Assert.Equal("Base.esm", afterDeletion.Plugin.Name);

        var edited = winnersBody.Replace("TestNpc", "RestoredByWorkingTree", StringComparison.Ordinal);
        Assert.NotEqual(winnersBody, edited);
        index.Create(_winner, _npc, "npc_", "TestNpc", edited);

        var effectiveWinner = reads.GetDocument(_npc);
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Winner.esp", effectiveWinner.Plugin.Name);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal("RestoredByWorkingTree", effectiveWinner.EditorId);

        var stack = reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        Assert.Equal([("Base.esm", false), ("Winner.esp", true)], stack.Entries.Select(e => (e.Plugin.Name, e.IsWinner)));
        var winnerEntry = stack.Entries.Single(e => e.Plugin.Name == "Winner.esp");
        Assert.True(winnerEntry.HasWorkingTreeChange);
    }

    [Fact]
    public void DeletingARecord_StopsItResolving_AndLeavesOtherRecordsResolving()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        Assert.NotNull(reads.LinkResolver(_raceA)(_raceA));

        index.Delete(_base, reads.DocumentOf(_raceA, _baseKey));

        Assert.Null(reads.LinkResolver(_raceA)(_raceA));
        Assert.NotNull(reads.LinkResolver(_raceB)(_raceB));
    }

    [Fact]
    public void EditingAFormLink_MovesTheRecordInTheReferenceGraph()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        Assert.Contains(reads.GetReferencedBy(_raceA), r => r.FormKey == _npc);
        Assert.DoesNotContain(reads.GetReferencedBy(_raceB), r => r.FormKey == _npc);

        var npcDocument = reads.DocumentOf(_npc, _baseKey);
        var body = npcDocument.BodyOf();
        Assert.Contains(_raceA, body, StringComparison.Ordinal);
        index.Edit(_base, npcDocument, body.Replace(_raceA, _raceB, StringComparison.Ordinal));

        Assert.DoesNotContain(reads.GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");
        Assert.Contains(reads.GetReferencedBy(_raceB), r => r.FormKey == _npc && r.Plugin == "Base.esm");
    }

    [Fact]
    public void DeletingARecord_TakesItsOutgoingReferencesWithIt()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        Assert.Contains(reads.GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");

        index.Delete(_base, reads.DocumentOf(_npc, _baseKey));

        Assert.DoesNotContain(reads.GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");
    }
}
