using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>A body is what every extracted index table was built from, so an edit that updates one
/// and not the others leaves the read model disagreeing with itself; a deletion is the sharpest
/// case.</summary>
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

        // The committed row is kept beneath the deletion: the same bytes coming back is no change at
        // all, not a record the working tree added.
        index.Create(_base, _raceA, "race", "RaceA", committed.BodyOf());
        var restored = reads.StackEntry(_raceA, _baseKey);
        Assert.NotNull(restored);
        Assert.False(restored.HasWorkingTreeChange);
        Assert.Equal("RaceA", restored.Head.EditorId);
    }

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_AtEffective()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var initialWinner = reads.GetDocument(_npc);
        Assert.NotNull(initialWinner);
        Assert.Equal("Winner.esp", initialWinner.Plugin.Name);

        // Winner.esp's copy is deleted in its working tree and Base.esm's must become the winner: a
        // winner is a fact about the stack that survives at this ref, not a stored flag that goes stale.
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
    public void RestoringADeletedOverride_MakesItTheEffectiveWinnerAgain_WithoutMovingHead()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var winnersDocument = reads.DocumentOf(_npc, _winnerKey);
        var winnersCopy = winnersDocument.BodyOf();

        // Winner.esp's copy is deleted in its working tree, so Base.esm holds the field...
        index.Delete(_winner, winnersDocument);
        var afterDeletion = reads.GetDocument(_npc);
        Assert.NotNull(afterDeletion);
        Assert.Equal("Base.esm", afterDeletion.Plugin.Name);

        // ...and then the file comes back carrying a different value, the direction a create takes
        // too, so its appearance has to move winner status.
        var edited = winnersCopy.Replace("TestNpc", "RestoredByWorkingTree", StringComparison.Ordinal);
        Assert.NotEqual(winnersCopy, edited);
        index.Create(_winner, _npc, "npc_", "TestNpc", edited);

        var effectiveWinner = reads.GetDocument(_npc);
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Winner.esp", effectiveWinner.Plugin.Name);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal("RestoredByWorkingTree", effectiveWinner.EditorId);

        // Head never lost it: the committed copy is the one the deletion was made over.
        var stack = reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        Assert.Equal([("Base.esm", false), ("Winner.esp", true)], stack.Entries.Select(e => (e.Plugin.Name, e.IsWinner)));
        var winnerEntry = stack.Entries.Single(e => e.Plugin.Name == "Winner.esp");
        Assert.True(winnerEntry.HasWorkingTreeChange);
        Assert.Equal("TestNpc", winnerEntry.Head.EditorId);
    }

    [Fact]
    public void DeletingARecord_StopsItResolving_SoAFormLinkToItReadsAsDangling()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        Assert.NotNull(reads.Resolve(_raceA));

        index.Delete(_base, reads.DocumentOf(_raceA, _baseKey));

        // FormKey resolution is what every FormLink check reads (CheckErrorBuilder), so this is the
        // mechanism by which a link to a record the working tree deleted becomes a dangling link.
        Assert.Null(reads.Resolve(_raceA));
        Assert.NotNull(reads.Resolve(_raceB));
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
        Assert.Contains(_raceA, body, StringComparison.Ordinal); // the fixture really does carry the link being repointed
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
