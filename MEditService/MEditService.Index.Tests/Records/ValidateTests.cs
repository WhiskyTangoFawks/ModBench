using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0015 invariant 4: the indexer compares what it holds against the system of record
/// and repairs the difference. Over a real git working tree, because what git answers is under
/// test.</summary>
public sealed class ValidateTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly Indexer _index;
    private readonly string _npc;

    public ValidateTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-tracked")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IRecordReads Reads => _index.RequireReads();

    private ValidationReport Validate() => Assert.Single(_index.ValidateIndex(_mod.KeyOf()));

    [Fact]
    public void AHandEditToASourceDocument_IsFoundAndRefreshed()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        var before = _index.Sequence;

        var report = Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Assert.Contains(_npc, report.ChangedKeys, StringComparer.Ordinal);
        Assert.True(_index.Sequence > before);
    }

    [Fact]
    public void APluginWhoseRowsAllMatch_ChangesNoRowAndAdvancesNoSequence()
    {
        var before = _index.Sequence;

        var report = Validate();

        Assert.Empty(report.ChangedKeys);
        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.Failures);
        Assert.Equal(before, _index.Sequence);
    }

    // The gap RefreshByKeys leaves and validate closes: git answers the same for an absent blob and a
    // transient failure, so a per-key refresh fails closed. One whole-tree listing makes absence from
    // a successful read conclusive.
    [Fact]
    public void ARecordGoneFromTheCommittedTree_LosesItsCommittedRows()
    {
        var relative = Path.GetRelativePath(_mod.ModFolderOf(), _mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf())));
        _mod.Git("rm", "-q", "--cached", relative);
        _mod.Git("commit", "-q", "-m", "removed from the committed tree outside Modbench");

        var report = Validate();

        // Held at the working tree and no committed ref: what the listing reports as an addition.
        Assert.NotNull(Reads.GetDocument(_npc, _mod.KeyOf()));
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
        Assert.Contains(_npc, report.ChangedKeys, StringComparer.Ordinal);
        Assert.Empty(report.Failures);
    }

    [Fact]
    public void AnUnreadableCommittedTree_IsReportedAndChangesNothing()
    {
        // An unborn HEAD: git cannot list the committed tree, and answers the same way it would for a
        // repository mid-rebase or with a corrupt object.
        _mod.Git("symbolic-ref", "HEAD", "refs/heads/no-such-branch");
        var before = _index.Sequence;

        var report = Validate();

        Assert.NotEmpty(report.Failures);
        var entry = Reads.StackEntry(_npc, _mod.KeyOf());
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(before, _index.Sequence);
    }
}
