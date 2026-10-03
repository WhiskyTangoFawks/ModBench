using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class RecordRefDivergenceTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
    private readonly PluginAddress _winnerKey;
    private readonly string _keptNpc;
    private readonly string _soleSourcedNpcWhoseOneEntryIsItsOwnWinner;

    public RecordRefDivergenceTests()
    {
        FormKey keptFk = default, droppedFk = default;
        _fixture = new PluginFixtureBuilder("recordref-identity")
            .WithPlugin("Base.esm", mod =>
            {
                keptFk = mod.Npcs.AddNew("KeepMe").FormKey;
                droppedFk = mod.Npcs.AddNew("DropMe").FormKey;
            }, origin: "BaseMod")
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == keptFk).DeepCopy());
            }, origin: "WinnerMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _baseKey = _base.KeyOf();
        _winnerKey = _fixture.Plugins.Single(p => p.Name == "Winner.esp").KeyOf();
        _keptNpc = keptFk.ToString();
        _soleSourcedNpcWhoseOneEntryIsItsOwnWinner = droppedFk.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ACleanRecord_CarriesOneDocumentForBothRefs_WithAnActiveFilterNarrowingTheListing()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var filterNarrowingToKeepMesTwoOverrideRowsOfTheFixturesThree = $"SELECT '{_keptNpc}' AS form_key";
        index.SetFilter(filterNarrowingToKeepMesTwoOverrideRowsOfTheFixturesThree, "filter.sql");

        var listing = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(2, listing.Total);
        Assert.All(listing.Items, i => Assert.Equal(_keptNpc, i.FormKey));

        var stack = reads.GetOverrideStack(_keptNpc);
        Assert.NotNull(stack);
        Assert.All(stack.Entries, e =>
        {
            Assert.False(e.HasWorkingTreeChange);
            Assert.Same(e.Effective, e.Head);
        });
    }

    [Fact]
    public void TheCommittedEntry_MatchesTheEffectiveOne_IncludingTheNonWinningEntry()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();

        var stack = reads.GetOverrideStack(_keptNpc);
        Assert.NotNull(stack);
        Assert.Equal(2, stack.Entries.Count);
        Assert.Equal(
            stack.Entries.Select(e => (e.Plugin, e.IsWinner)),
            stack.Entries.Select(e => (e.Head.Plugin, e.Head.IsWinner)));

        var dropped = reads.StackEntry(_soleSourcedNpcWhoseOneEntryIsItsOwnWinner, _baseKey);
        Assert.NotNull(dropped);
        Assert.True(dropped.IsWinner);
        Assert.True(dropped.Head.IsWinner);
        Assert.Equal(dropped.Effective.Plugin, dropped.Head.Plugin);
    }

    [Fact]
    public void AWorkingTreeChange_DivergesOnlyTheEditedRecord_LeavingEveryOtherRefAnswerAlone()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var before = reads.DocumentOf(_keptNpc, _baseKey);
        index.Edit(_base, before, before.BodyOf().Replace("KeepMe", "RenamedInWorkingTree", StringComparison.Ordinal));

        var stack = reads.GetOverrideStack(_keptNpc);
        Assert.NotNull(stack);
        var baseEntry = stack.Entries.Single(e => e.Plugin.Equals(_baseKey));
        Assert.True(baseEntry.HasWorkingTreeChange);
        Assert.NotEqual(baseEntry.Effective.Body, baseEntry.Head.Body);

        var winnerEntry = stack.Entries.Single(e => e.Plugin.Equals(_winnerKey));
        Assert.False(winnerEntry.HasWorkingTreeChange);
        Assert.Equal(winnerEntry.Effective.Body, winnerEntry.Head.Body);

        var untouched = reads.StackEntry(_soleSourcedNpcWhoseOneEntryIsItsOwnWinner, _baseKey);
        Assert.NotNull(untouched);
        Assert.False(untouched.HasWorkingTreeChange);
        Assert.Equal(untouched.Effective.Body, untouched.Head.Body);
    }
}
