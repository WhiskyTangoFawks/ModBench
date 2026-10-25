using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class ValidateContainerByStampsTests : IDisposable
{
    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string PlacedRefEditorId =>
        _fixture.Index.DocumentOf(_fixture.TemporaryRef, _fixture.Plugin).EditorId
        ?? throw new InvalidOperationException("Expected the placed reference to carry an EditorID.");

    private void ValidateUntilPlacedRefIsNamed(string editorId) =>
        _fixture.Index.NextSnapshotUntil(() => _fixture.Index.CopyIn(_fixture.TemporaryRef, _fixture.Plugin)?.EditorId == editorId, $"the placed reference named {editorId}");

    private string CellDirectory => Path.GetDirectoryName(_fixture.Mod.SourceFileContaining(ContainerModPlugin.TemporaryRefEditorId)).Require();

    private void ValidateUntilSourceUnreadable() =>
        _fixture.Index.NextSnapshotUntil(() => _fixture.Index.ReadFromItsPluginFileForItsUnreadableSource(_fixture.Plugin), "the plugin read from its binary in place of its source");

    private void ValidateUntilSourceRead() =>
        _fixture.Index.NextSnapshotUntil(() => !_fixture.Index.ReadFromItsPluginFileForItsUnreadableSource(_fixture.Plugin), "the plugin read from its source again");

    [Fact]
    public void AGitRevertOfAPlacedRefsOwningCellDocument_ReachesTheNextRead()
    {
        var cellDocument = _fixture.Mod.SourceFileContaining(ContainerModPlugin.TemporaryRefEditorId);
        File.WriteAllText(
            cellDocument,
            File.ReadAllText(cellDocument).Replace($"\"{ContainerModPlugin.TemporaryRefEditorId}\"", "\"EditedByHand\"", StringComparison.Ordinal));
        ValidateUntilPlacedRefIsNamed("EditedByHand");

        _fixture.Entry.Git("checkout", "--", Path.GetRelativePath(_fixture.Entry.ModFolderOf(), cellDocument).Replace('\\', '/'));

        ValidateUntilPlacedRefIsNamed(ContainerModPlugin.TemporaryRefEditorId);
        Assert.Equal(ContainerModPlugin.TemporaryRefEditorId, PlacedRefEditorId);
        Assert.Equal(WorkingTreeState.None, _fixture.Index.RowOf(_fixture.TemporaryRef, _fixture.Plugin)?.WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, _fixture.Index.RowOf(_fixture.EmbedCell, _fixture.Plugin)?.WorkingTreeState);
    }

    [Fact]
    public void APlacedReferenceTwoCellsCarry_IsDiagnosed_NamingBothDocuments()
    {
        var original = _fixture.Mod.SourceFileContaining(ContainerModPlugin.TemporaryRefEditorId);
        var directory = CellDirectory;
        AnotherTool.CopyDirectory(directory, "CopiedCell - 000950_ContainerFixture.esp");
        var copy = Directory.GetFiles(AnotherTool.Beside(directory, "CopiedCell - 000950_ContainerFixture.esp")).Single();
        var text = File.ReadAllText(copy);
        File.WriteAllText(copy, text.Replace(_fixture.EmbedCell, "000950:ContainerFixture.esp", StringComparison.Ordinal));

        ValidateUntilSourceUnreadable();

        var problems = _fixture.Index.Queries.GetProblems().Value().Single(p => PluginAddress.Comparer.Equals(p.Plugin, _fixture.Plugin));
        Assert.Equivalent(
            new[]
            {
                Path.GetRelativePath(_fixture.Entry.ModFolderOf(), original),
                Path.GetRelativePath(_fixture.Entry.ModFolderOf(), copy),
            },
            problems.Problems.Select(p => p.SourceRelativePath),
            strict: true);
    }

    [Fact]
    public void ACellDirectoryCopiedThenDeletedByHandUnderANameWithoutItsFormKey_KeepsItsRecords()
    {
        var directory = CellDirectory;
        AnotherTool.CopyDirectory(directory, "RenamedByHand");
        ValidateUntilSourceUnreadable();

        Directory.Delete(directory, recursive: true);
        ValidateUntilSourceRead();

        Assert.Equal(ContainerModPlugin.EmbedCellEditorId, _fixture.Index.DocumentOf(_fixture.EmbedCell, _fixture.Plugin).EditorId);
        Assert.Equal(ContainerModPlugin.TemporaryRefEditorId, PlacedRefEditorId);
    }

    [Theory]
    [InlineData("cell", ContainerModPlugin.EmbedCellEditorId)]
    [InlineData("wrld", ContainerModPlugin.WorldspaceEditorId)]
    public void AContainerDirectoryDeletedThenWrittenByHandUnderANameWithoutItsFormKey_BringsItsRecordBack(string recordType, string editorId)
    {
        var formKey = _fixture.Index.Queries.GetRecords([recordType], _fixture.Plugin, search: null, limit: 10, offset: 0).Value()
            .Items.Single(row => row.EditorId == editorId).FormKey;
        var document = _fixture.Mod.SourceFileContaining(editorId);
        var directory = Path.GetDirectoryName(document).Require();
        var text = File.ReadAllText(document);
        Directory.Delete(directory, recursive: true);
        _fixture.Index.NextSnapshotUntil(() => _fixture.Index.CopyIn(formKey, _fixture.Plugin) is null, "the container gone");

        var written = Path.Combine(AnotherTool.Beside(directory, "RenamedByHand"), Path.GetFileName(document));
        Directory.CreateDirectory(Path.GetDirectoryName(written).Require());
        File.WriteAllText(written, text);
        _fixture.Index.NextSnapshotUntil(() => _fixture.Index.CopyIn(formKey, _fixture.Plugin) is not null, "the container back");

        Assert.Equal(editorId, _fixture.Index.DocumentOf(formKey, _fixture.Plugin).EditorId);
    }
}
