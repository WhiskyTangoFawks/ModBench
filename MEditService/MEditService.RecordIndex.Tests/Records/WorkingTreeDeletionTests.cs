using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

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
            .CompiledPlugin();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _winner = _fixture.Plugins.Single(p => p.Name == "Winner.esp");
        _baseKey = _base.Key;
        _winnerKey = _winner.Key;
        (_npc, _raceA, _raceB) = (npc.ToString(), raceA.ToString(), raceB.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<(string Plugin, bool IsWinner)> StackOf(OpenedIndex index, string formKey) =>
        index.StackOf(formKey).Select(copy => (copy.Plugin, copy.IsWinner));

    private static bool ReferencedFromBase(OpenedIndex index, string target, string formKey) =>
        index.Queries.GetReferencesInActiveOrCompiledPlugins(target).Value().Any(r => r.FormKey == formKey && r.Plugin == "Base.esm");

    private const string ActivePlugins = "active_plugins";

    private void AwaitBasePromoted(OpenedIndex index) =>
        Waits.Reached(() => StackOf(index, _npc).SequenceEqual([("Base.esm", true)]), "Base.esm winning the stack");

    private OpenedIndex IndexWhoseSweepFailedAfterDeletingTheWinner()
    {
        var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, $"ALTER TABLE {ActivePlugins} RENAME TO active_aside");
        _winner.RemoveFromTree(index.DocumentOf(_npc, _winnerKey));
        index.SignalChange();
        Waits.Reached(() => index.Status.State == LoadOrderState.Failed, "the failed sweep's status");
        IndexFiles.Execute(_fixture.InstanceRoot, $"ALTER TABLE active_aside RENAME TO {ActivePlugins}");
        return index;
    }

    [Fact]
    public void AWinnerSweepThatFails_FailsTheStatus_AndStaysOwedUntilALaterCheckLandsIt()
    {
        using var index = IndexWhoseSweepFailedAfterDeletingTheWinner();

        index.SignalChange();

        AwaitBasePromoted(index);
    }

    [Fact]
    public void AWinnerSweepOwed_IsPaidByACheckThatNamesNoHeldPlugin()
    {
        using var index = IndexWhoseSweepFailedAfterDeletingTheWinner();

        index.SignalChange([new PluginAddress("Absent.esp", "AbsentMod")]);

        AwaitBasePromoted(index);
    }

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_AtEffective()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.Equal("Winner.esp", index.Queries.GetWinner(_npc).Value()?.Plugin);

        index.Delete(_winner, index.DocumentOf(_npc, _winnerKey));

        var effectiveWinner = index.Queries.GetWinner(_npc).Value();
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
        Assert.Equal("Base.esm", index.Queries.GetWinner(_npc).Value()?.Plugin);

        var edited = winnersBody.Replace("TestNpc", "RestoredByWorkingTree", StringComparison.Ordinal);
        Assert.NotEqual(winnersBody, edited);
        index.Create(_winner, _npc, "npc_", "TestNpc", edited);

        var effectiveWinner = index.Queries.GetWinner(_npc).Value();
        Assert.NotNull(effectiveWinner);
        Assert.Equal("Winner.esp", effectiveWinner.Plugin);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal("RestoredByWorkingTree", effectiveWinner.EditorId);

        Assert.Equal([("Base.esm", false), ("Winner.esp", true)], StackOf(index, _npc));
        Assert.NotEqual(WorkingTreeState.None, index.RowOf(_npc, _winnerKey)?.WorkingTreeState);
    }

    [Fact]
    public void EditingAFormLink_MovesTheRecordInTheReferenceGraph()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.Contains(index.Queries.GetReferencesInActiveOrCompiledPlugins(_raceA).Value(), r => r.FormKey == _npc);
        Assert.DoesNotContain(index.Queries.GetReferencesInActiveOrCompiledPlugins(_raceB).Value(), r => r.FormKey == _npc);

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
