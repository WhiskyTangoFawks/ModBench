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

    private RecordSummary RowOf(OpenedIndex index) =>
        index.RowOf(_formKey, _baseKey) ?? throw new InvalidOperationException($"Expected {_formKey} to be listed.");

    [Fact]
    public void AnEdit_MakesTheEffectiveDocumentServeTheNewBody()
    {
        using var index = Indexes.Reconciled(_fixture);
        var committed = index.DocumentOf(_formKey, _baseKey);
        var committedBody = index.BodyOf(_formKey, _baseKey);
        var editedBody = committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal);
        Assert.NotEqual(committedBody, editedBody);

        index.Edit(_base, committed, editedBody);

        Assert.Equal(editedBody, index.BodyOf(_formKey, _baseKey));
        Assert.Equal("EditedName", index.DocumentOf(_formKey, _baseKey).EditorId);
    }

    [Fact]
    public void AnEdit_MarksTheRecordsRowModified()
    {
        using var index = Indexes.Reconciled(_fixture);
        var committed = index.DocumentOf(_formKey, _baseKey);
        Assert.Equal(WorkingTreeState.None, RowOf(index).WorkingTreeState);

        index.Edit(_base, committed, index.BodyOf(_formKey, _baseKey).Replace("OriginalName", "EditedName", StringComparison.Ordinal));

        var dirty = RowOf(index);
        Assert.Equal(WorkingTreeState.Modified, dirty.WorkingTreeState);
        Assert.Equal("EditedName", dirty.EditorId);
    }

    [Fact]
    public void EditingBackToTheCommittedBytes_ConvergesToClean()
    {
        using var index = Indexes.Reconciled(_fixture);
        var committed = index.DocumentOf(_formKey, _baseKey);
        var committedBody = index.BodyOf(_formKey, _baseKey);

        index.Edit(_base, committed, committedBody.Replace("OriginalName", "EditedName", StringComparison.Ordinal));
        Assert.Equal(WorkingTreeState.Modified, RowOf(index).WorkingTreeState);

        index.Edit(_base, index.DocumentOf(_formKey, _baseKey), committedBody);

        Assert.Equal(WorkingTreeState.None, RowOf(index).WorkingTreeState);
        Assert.Equal(committedBody, index.BodyOf(_formKey, _baseKey));
    }
}
