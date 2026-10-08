using MEditService.Codec.Schema;
using MEditService.Index.Queries;
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
    private readonly string _loneNpcWhoseOneCopyAnswersTheLink;
    private readonly string _raceA;
    private readonly string _raceB;

    public WorkingTreeDeletionTests()
    {
        FormKey npc = default, raceA = default, raceB = default, loneNpc = default;
        _fixture = new PluginFixtureBuilder("working-tree-deletion")
            .WithPlugin("Base.esm", mod =>
            {
                raceA = mod.Races.AddNew("RaceA").FormKey;
                raceB = mod.Races.AddNew("RaceB").FormKey;
                var n = mod.Npcs.AddNew("TestNpc");
                n.Race.SetTo(raceA);
                npc = n.FormKey;
                loneNpc = mod.Npcs.AddNew("LoneNpc").FormKey;
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
        _loneNpcWhoseOneCopyAnswersTheLink = loneNpc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<(string Plugin, bool IsWinner)> StackOf(OpenedIndex index, string formKey) =>
        index.StackOf(formKey).Select(copy => (copy.Plugin, copy.IsWinner));

    private FormKeyResolutionState LinkTo(OpenedIndex index, string target) =>
        index.ResolutionOf(_loneNpcWhoseOneCopyAnswersTheLink, _baseKey, target).State;

    private static bool ReferencedFromBase(OpenedIndex index, string target, string formKey) =>
        index.Records.GetReferences(target).Any(r => r.FormKey == formKey && r.Plugin == "Base.esm");

    [Fact]
    public void DeletingARecord_RemovesItFromEffective_AndRestoringItsCommittedBytesConvergesToClean()
    {
        using var index = Indexes.Reconciled(_fixture);
        var committed = index.DocumentOf(_raceA, _baseKey);
        var committedBody = index.BodyOf(_raceA, _baseKey);

        index.Delete(_base, committed);

        Assert.Null(index.CopyIn(_raceA, _baseKey));
        Assert.Null(index.Records.GetRecord(_raceA));

        index.Create(_base, _raceA, "race", "RaceA", committedBody);
        Assert.Equal(WorkingTreeState.None, index.RowOf(_raceA, _baseKey)?.WorkingTreeState);
    }

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_AtEffective()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.Equal("Winner.esp", index.Records.GetRecord(_npc)?.Plugin);

        index.Delete(_winner, index.DocumentOf(_npc, _winnerKey));

        var effectiveWinner = index.Records.GetRecord(_npc);
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Base.esm", effectiveWinner.Plugin);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal([("Base.esm", true)], StackOf(index, _npc));
    }

    [Fact]
    public void RestoringADeletedOverride_MakesItTheEffectiveWinnerAgain()
    {
        using var index = Indexes.Reconciled(_fixture);
        var winnersBody = index.BodyOf(_npc, _winnerKey);

        index.Delete(_winner, index.DocumentOf(_npc, _winnerKey));
        Assert.Equal("Base.esm", index.Records.GetRecord(_npc)?.Plugin);

        var edited = winnersBody.Replace("TestNpc", "RestoredByWorkingTree", StringComparison.Ordinal);
        Assert.NotEqual(winnersBody, edited);
        index.Create(_winner, _npc, "npc_", "TestNpc", edited);

        var effectiveWinner = index.Records.GetRecord(_npc);
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Winner.esp", effectiveWinner.Plugin);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal("RestoredByWorkingTree", effectiveWinner.EditorId);

        Assert.Equal([("Base.esm", false), ("Winner.esp", true)], StackOf(index, _npc));
        Assert.NotEqual(WorkingTreeState.None, index.RowOf(_npc, _winnerKey)?.WorkingTreeState);
    }

    [Fact]
    public void DeletingARecord_StopsItResolving_AndLeavesOtherRecordsResolving()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, LinkTo(index, _raceA));

        index.Delete(_base, index.DocumentOf(_raceA, _baseKey));

        Assert.Equal(FormKeyResolutionState.Unresolved, LinkTo(index, _raceA));
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, LinkTo(index, _raceB));
    }

    [Fact]
    public void EditingAFormLink_MovesTheRecordInTheReferenceGraph()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.Contains(index.Records.GetReferences(_raceA), r => r.FormKey == _npc);
        Assert.DoesNotContain(index.Records.GetReferences(_raceB), r => r.FormKey == _npc);

        var body = index.BodyOf(_npc, _baseKey);
        Assert.Contains(_raceA, body, StringComparison.Ordinal);
        index.Edit(_base, index.DocumentOf(_npc, _baseKey), body.Replace(_raceA, _raceB, StringComparison.Ordinal));

        Assert.False(ReferencedFromBase(index, _raceA, _npc));
        Assert.True(ReferencedFromBase(index, _raceB, _npc));
    }

    [Fact]
    public void DeletingARecord_TakesItsOutgoingReferencesWithIt()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.True(ReferencedFromBase(index, _raceA, _npc));

        index.Delete(_base, index.DocumentOf(_npc, _baseKey));

        Assert.False(ReferencedFromBase(index, _raceA, _npc));
    }
}
