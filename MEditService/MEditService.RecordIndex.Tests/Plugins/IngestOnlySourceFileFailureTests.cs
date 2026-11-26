using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class IngestOnlySourceFileFailureTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ATreeRefusedAtItsFirstRead_NamesTheFileAndItsFormKey_WithTheRefusalsReason()
    {
        var cell = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(cell, File.ReadAllText(cell).Replace($"\"{ContainerModPlugin.EmbedCellEditorId}\"", "5", StringComparison.Ordinal));

        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal(
            (Path.GetRelativePath(_fixture.Entry.ModFolderOf(), cell), _fixture.EmbedCell.ToString()),
            (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("'EditorID' is not a string", failure.Message, StringComparison.Ordinal);
    }
}
