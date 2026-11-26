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
        _fixture.Index.NextCheckUntil(() => _fixture.Index.CopyIn(_fixture.TemporaryRef, _fixture.Plugin)?.EditorId == editorId, $"the placed reference named {editorId}");

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

    [Theory]
    [InlineData("wrld", ContainerModPlugin.WorldspaceEditorId)]
    public void AContainerDirectoryDeletedThenWrittenByHandUnderANameWithoutItsFormKey_BringsItsRecordBack(string recordType, string editorId)
    {
        var formKey = _fixture.Index.Queries.GetRecords([recordType], _fixture.Plugin, search: null, limit: 10, offset: 0).Value()
            .Items.Single(row => row.EditorId == editorId).FormKey;
        var document = _fixture.Mod.SourceFileContaining(editorId);
        var directory = Path.GetDirectoryName(document).Require();
        var text = File.ReadAllText(document);
        Directory.Delete(directory, recursive: true);
        _fixture.Index.NextCheckUntil(() => _fixture.Index.CopyIn(formKey, _fixture.Plugin) is null, "the container gone");

        var written = Path.Combine(AnotherTool.Beside(directory, "RenamedByHand"), Path.GetFileName(document));
        Directory.CreateDirectory(Path.GetDirectoryName(written).Require());
        File.WriteAllText(written, text);
        _fixture.Index.NextCheckUntil(() => _fixture.Index.CopyIn(formKey, _fixture.Plugin) is not null, "the container back");

        Assert.Equal(editorId, _fixture.Index.DocumentOf(formKey, _fixture.Plugin).EditorId);
    }
}
