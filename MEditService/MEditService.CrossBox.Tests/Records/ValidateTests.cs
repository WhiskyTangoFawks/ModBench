using MEditService.Index;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>ADR-0015 invariant 4: the projector compares what it holds against the system of record
/// and repairs the difference. Through the Index's own seam with a real git working tree, because
/// what git answers is under test.</summary>
public sealed class ValidateTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordReads Reads => _mod.Index.RequireReads();

    private ValidationReport Validate() => Assert.Single(_mod.Index.ValidateIndex(_mod.Plugin));

    [Fact]
    public void AHandEditToASourceDocument_IsFoundAndRefreshed()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        var before = _mod.Index.Sequence;

        var report = Validate();

        var effective = Reads.GetDocument(_mod.Npc.ToString(), _mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedByHand", effective.EditorId);
        Assert.Contains(_mod.Npc.ToString(), report.ChangedKeys, StringComparer.Ordinal);
        Assert.True(_mod.Index.Sequence > before);
    }

    [Fact]
    public void APluginWhoseRowsAllMatch_ChangesNoRowAndAdvancesNoSequence()
    {
        var before = _mod.Index.Sequence;

        var report = Validate();

        Assert.Empty(report.ChangedKeys);
        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.Failures);
        Assert.Equal(before, _mod.Index.Sequence);
    }

    // The gap RefreshByKeys leaves and validate closes: git answers the same for an absent blob and a
    // transient failure, so a per-key refresh fails closed. One whole-tree listing makes absence from
    // a successful read conclusive.
    [Fact]
    public void ARecordGoneFromTheCommittedTree_LosesItsCommittedRows()
    {
        var formKey = _mod.Npc.ToString();
        Git("rm", "-q", "--cached", _mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId));
        Git("commit", "-q", "-m", "removed from the committed tree outside Modbench");

        var report = Validate();

        // Held at the working tree and no committed ref: what the listing reports as an addition.
        Assert.NotNull(Reads.GetDocument(formKey, _mod.Plugin));
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Plugin.Name, Origin: _mod.Plugin.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == formKey).WorkingTreeState);
        Assert.Contains(formKey, report.ChangedKeys, StringComparer.Ordinal);
        Assert.Empty(report.Failures);
    }

    [Fact]
    public void AnUnreadableCommittedTree_IsReportedAndChangesNothing()
    {
        var formKey = _mod.Npc.ToString();
        // An unborn HEAD: git cannot list the committed tree, and answers the same way it would for a
        // repository mid-rebase or with a corrupt object.
        Git("symbolic-ref", "HEAD", "refs/heads/no-such-branch");
        var before = _mod.Index.Sequence;

        var report = Validate();

        Assert.NotEmpty(report.Failures);
        var entry = Reads.StackEntry(formKey, _mod.Plugin);
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(before, _mod.Index.Sequence);
    }

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);
}
