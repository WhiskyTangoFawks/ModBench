using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>Bodies are real codec documents edited as text, not hand-written JSON: the invariant is
/// "Body bytes = the source file's bytes at that ref", so a fabricated body would test a shape the
/// codec never emits.</summary>
public sealed class WorkingTreeChangeTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
    private readonly string _formKey;

    public WorkingTreeChangeTests()
    {
        FormKey fk = default;
        _fixture = new PluginFixtureBuilder("working-tree-change")
            .WithPlugin("Base.esm", mod => fk = mod.Npcs.AddNew("OriginalName").FormKey, origin: "BaseMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single();
        _baseKey = _base.KeyOf();
        _formKey = fk.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    // EditorID is an identity column, not a reflected field, so this reads the projection of the
    // body every listing, resolve and tree row is built from.
    private static string EditorIdOf(RecordDocument document) =>
        document.EditorId ?? throw new InvalidOperationException("The fixture record has no EditorID.");

    [Fact]
    public void RefreshKeys_EffectiveServesTheNewBody_WhileHeadKeepsTheCommittedOne()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);
        var committedBody = committed.BodyOf();
        var editedBody = committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        Assert.NotEqual(committedBody, editedBody); // the fixture really does carry the text being replaced

        index.Edit(_base, committed, editedBody);

        var effective = reads.DocumentOf(_formKey, _baseKey);
        Assert.Equal(editedBody, effective.Body);
        Assert.Equal("EditedName", EditorIdOf(effective));

        var head = reads.HeadDocument(_formKey, _baseKey);
        Assert.NotNull(head);
        Assert.Equal(committedBody, head.Body);
        Assert.Equal("OriginalName", EditorIdOf(head));
    }

    [Fact]
    public void RefreshKeys_MarksTheOverrideStackEntryAsCarryingAWorkingTreeChange()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);

        var clean = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(clean);
        Assert.False(clean.HasWorkingTreeChange);
        Assert.Equal(clean.Effective.Body, clean.Head.Body);

        index.Edit(_base, committed, committed.BodyOf().Replace("OriginalName", "EditedName", StringComparison.Ordinal));

        var dirty = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(dirty);
        Assert.True(dirty.HasWorkingTreeChange);
        Assert.Equal("EditedName", EditorIdOf(dirty.Effective));
        Assert.Equal("OriginalName", EditorIdOf(dirty.Head));
    }

    [Fact]
    public void RefreshKeys_EditingBackToTheCommittedBytes_ConvergesToClean()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);
        var committedBody = committed.BodyOf();

        index.Edit(_base, committed, committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal));
        var dirty = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(dirty);
        Assert.True(dirty.HasWorkingTreeChange);

        // Byte compare *is* the revert-convergence detection — an edit back to the
        // committed bytes is not "a change that happens to match", it is no change at all.
        index.Edit(_base, reads.DocumentOf(_formKey, _baseKey), committedBody);

        var reverted = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(reverted);
        Assert.False(reverted.HasWorkingTreeChange);
        Assert.Equal(committedBody, reverted.Effective.Body);
        Assert.Equal(committedBody, reverted.Head.Body);
    }
}
