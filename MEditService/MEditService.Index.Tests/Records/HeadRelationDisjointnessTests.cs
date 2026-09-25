using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>The committed state is one row per record, never two. Read straight off the Index,
/// since a read-time self-heal would repair the damage before it could be seen.</summary>
public sealed class HeadRelationDisjointnessTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly PluginAddress _key;
    private readonly string _formKey;

    public HeadRelationDisjointnessTests()
    {
        FormKey fk = default;
        _fixture = new PluginFixtureBuilder("head-relation-disjointness")
            .WithPlugin("Fixture.esp", mod => fk = mod.Npcs.AddNew("OriginalName").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        _key = _entry.KeyOf();
        _formKey = fk.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public async Task ReindexingAPluginWithADirtyRecord_KeepsTheUncommittedEdit_AndOneOverrideEntry()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _key);
        var editedBody = committed.BodyOf().Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        index.Edit(_entry, committed, editedBody);

        // Precondition: the record really is dirty, so a snapshot row exists to be duplicated.
        var stackBefore = reads.GetOverrideStack(_formKey);
        Assert.NotNull(stackBefore);
        var before = Assert.Single(stackBefore.Entries);
        Assert.True(before.HasWorkingTreeChange);

        PluginBinaries.Touch(_entry.Path);
        Assert.True(await index.RefreshBinary(_key, _entry.Path));

        // The edit survives: Effective still serves the working tree's text, not the binary's
        // untouched one (the binary was written by the fixture and has never been compiled since).
        var effective = reads.DocumentOf(_formKey, _key);
        Assert.Equal(editedBody, effective.Body);

        // ...and so does the divergence it created: still one entry, not a duplicate, and still
        // committed-versus-working-tree dirty, so it is still diffable and revertible.
        var stackAfter = reads.GetOverrideStack(_formKey);
        Assert.NotNull(stackAfter);
        var after = Assert.Single(stackAfter.Entries);
        Assert.True(after.HasWorkingTreeChange);
        Assert.NotEqual(after.Effective.Body, after.Head.Body);
    }

    [Fact]
    public async Task UnindexingAPluginWithADirtyRecord_LeavesNoRowsBehind()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _key);
        index.Edit(_entry, committed, committed.BodyOf().Replace("OriginalName", "EditedName", StringComparison.Ordinal));
        Assert.NotEmpty(reads.GetDocuments(_key));

        File.Delete(_entry.Path);
        Assert.True(await index.RefreshBinary(_key, _entry.Path));

        Assert.Null(reads.HeadDocument(_formKey, _key));
        Assert.Empty(reads.GetDocuments(_key));
    }
}
