using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class IngestOnlySourceFileFailureTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Reloaded() => Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);

    private string Relative(string path) => Path.GetRelativePath(_fixture.Entry.ModFolderOf(), path);

    private string CellFile => _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);

    private string TemporaryRef => _fixture.TemporaryRef.ToString();

    private void EditTheCell(string from, string to)
    {
        var file = CellFile;
        var text = File.ReadAllText(file);
        var edited = text.Replace(from, to, StringComparison.Ordinal);
        Assert.NotEqual(text, edited);
        File.WriteAllText(file, edited);
    }

    [Fact]
    public void AnEmbeddedChildsFormKeyAnotherFileAlsoClaims_NamesBothFiles()
    {
        var cell = CellFile;
        var npc = _fixture.SourceFileContaining(ContainerMod.NpcEditorId);
        var impostor = Path.Combine(Path.GetDirectoryName(npc).Require(), "Impostor.json");
        File.WriteAllText(impostor, File.ReadAllText(npc).Replace(_fixture.Npc.ToString(), TemporaryRef, StringComparison.Ordinal));

        using var index = Reloaded();

        Assert.Equivalent(
            new[] { (Relative(cell), TemporaryRef), (Relative(impostor), TemporaryRef) },
            index.SourceProblems().Select(f => (f.SourceRelativePath, f.FormKey)), strict: true);
    }

    private string CellFileWithItsEditorIdANumber(string editorId)
    {
        var cell = CellFile;
        EditTheCell($"\"{editorId}\"", "5");
        return cell;
    }

    [Fact]
    public void ATreeRefusedAtItsFirstRead_NamesTheFileAndItsFormKey_WithTheRefusalsReason()
    {
        var cell = CellFileWithItsEditorIdANumber(ContainerModPlugin.EmbedCellEditorId);

        using var index = Reloaded();

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(cell), _fixture.EmbedCell.ToString()), (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("'EditorID' is not a string", failure.Message, StringComparison.Ordinal);
    }
}
