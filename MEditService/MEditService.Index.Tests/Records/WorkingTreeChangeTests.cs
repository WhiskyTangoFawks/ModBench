using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

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

    private static string EditorIdColumnOf(RecordDocument document) =>
        document.EditorId ?? throw new InvalidOperationException("The fixture record has no EditorID.");

    [Fact]
    public void AnEdit_MakesTheEffectiveDocumentServeTheNewBody()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);
        var committedBody = committed.BodyOf();
        var editedBody = committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        Assert.NotEqual(committedBody, editedBody);

        index.Edit(_base, committed, editedBody);

        var effective = reads.DocumentOf(_formKey, _baseKey);
        Assert.Equal(editedBody, effective.Body);
        Assert.Equal("EditedName", EditorIdColumnOf(effective));
    }

    [Fact]
    public void AnEdit_MarksTheOverrideStackEntryAsCarryingAWorkingTreeChange()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);

        var clean = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(clean);
        Assert.False(clean.HasWorkingTreeChange);

        index.Edit(_base, committed, committed.BodyOf().Replace("OriginalName", "EditedName", StringComparison.Ordinal));

        var dirty = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(dirty);
        Assert.True(dirty.HasWorkingTreeChange);
        Assert.Equal("EditedName", EditorIdColumnOf(dirty.Effective));
    }

    [Fact]
    public void EditingBackToTheCommittedBytes_ConvergesToClean()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var committed = reads.DocumentOf(_formKey, _baseKey);
        var committedBody = committed.BodyOf();

        index.Edit(_base, committed, committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal));
        var dirty = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(dirty);
        Assert.True(dirty.HasWorkingTreeChange);

        index.Edit(_base, reads.DocumentOf(_formKey, _baseKey), committedBody);

        var reverted = reads.StackEntry(_formKey, _baseKey);
        Assert.NotNull(reverted);
        Assert.False(reverted.HasWorkingTreeChange);
        Assert.Equal(committedBody, reverted.Effective.Body);
    }
}
