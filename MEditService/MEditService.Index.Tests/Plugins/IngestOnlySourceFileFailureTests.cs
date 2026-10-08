using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Plugins;

public sealed class IngestOnlySourceFileFailureTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Reloaded() => Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

    private static bool AProblemIsNamed(OpenedIndex index) => index.Problems.GetProblems() is [{ Problems: [_, ..] }];

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
    public void AFileWhosePathAndTextNameNoRecordType_IsNamed_WithTheFormKeyItDeclares()
    {
        var npcFolder = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerMod.NpcEditorId)).Require();
        var untyped = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(npcFolder).Require(), "Untyped")).FullName, "Gained.json");
        File.WriteAllText(untyped, $$"""{"FormKey":"000ABC:{{ContainerMod.PluginName}}"}""");

        using var index = Reloaded();

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal(
            (Relative(untyped), $"000ABC:{ContainerMod.PluginName}"),
            (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("names a record type", failure.Message, StringComparison.Ordinal);
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

    [Fact]
    public void AnEmbeddedChildNoTypeResolves_NamesTheOwnersFile_AndTheChild()
    {
        EditTheCell("\"PlacedObject\"", "\"PlacedObjekt\"");

        using var index = Reloaded();

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal(Relative(CellFile), failure.SourceRelativePath);
        Assert.Contains(failure.FormKey, new[] { TemporaryRef, _fixture.PersistentRef.ToString() });
        Assert.Contains("PlacedObjekt", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEmbeddedChildNoTypeResolvesOnceRead_NamesTheOwnersFile_WhileItsLastGoodRowsStand()
    {
        using var index = Reloaded();
        EditTheCell("\"PlacedObject\"", "\"PlacedObjekt\"");

        index.NextSnapshotUntil(() => AProblemIsNamed(index), "the re-read's failure");

        Assert.Equal(Relative(CellFile), Assert.Single(index.SourceProblems()).SourceRelativePath);
        Assert.NotNull(index.CopyIn(TemporaryRef, _fixture.Plugin));
    }

    private string CellFileWithItsEditorIdANumber(string editorId)
    {
        var cell = CellFile;
        EditTheCell($"\"{editorId}\"", "5");
        return cell;
    }

    [Fact]
    public void AFileWhoseEditorIdIsNoString_IsNamed_WithTheFieldAndItsFormKey()
    {
        var cell = CellFileWithItsEditorIdANumber(ContainerModPlugin.EmbedCellEditorId);

        using var index = Reloaded();

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(cell), _fixture.EmbedCell.ToString()), (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("'EditorID' is not a string", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEmbeddedChildWhoseEditorIdIsNoString_NamesTheOwnersFile_TheChildAndTheField()
    {
        var cell = CellFileWithItsEditorIdANumber(ContainerModPlugin.TemporaryRefEditorId);

        using var index = Reloaded();

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(cell), TemporaryRef), (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("whose 'EditorID' is not a string", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEditorIdEditedIntoANumberOnceRead_NamesTheFile_WhileItsLastGoodRowsStand()
    {
        using var index = Reloaded();
        var cell = CellFileWithItsEditorIdANumber(ContainerModPlugin.EmbedCellEditorId);

        index.NextSnapshotUntil(() => AProblemIsNamed(index), "the re-read's failure");

        Assert.Equal(Relative(cell), Assert.Single(index.SourceProblems()).SourceRelativePath);
        Assert.Equal(
            ContainerModPlugin.EmbedCellEditorId,
            index.CopyIn(_fixture.EmbedCell.ToString(), _fixture.Plugin)?.EditorId);
    }

    [Fact]
    public void AnEmbeddedChildsEditorIdEditedIntoANumberOnceRead_NamesTheOwnersFile_WhileItsLastGoodRowsStand()
    {
        using var index = Reloaded();
        var cell = CellFileWithItsEditorIdANumber(ContainerModPlugin.TemporaryRefEditorId);

        index.NextSnapshotUntil(() => AProblemIsNamed(index), "the re-read's failure");

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(cell), TemporaryRef), (failure.SourceRelativePath, failure.FormKey));
        Assert.Equal(
            ContainerModPlugin.TemporaryRefEditorId, index.CopyIn(TemporaryRef, _fixture.Plugin)?.EditorId);
    }

    [Fact]
    public void AChildEditedToCarryItsOwnersFormKeyOnceRead_NamesTheOwnersFile_WhileItsLastGoodRowsStand()
    {
        using var index = Reloaded();
        var cell = CellFile;
        EditTheCell(TemporaryRef, _fixture.EmbedCell.ToString());

        index.NextSnapshotUntil(() => AProblemIsNamed(index), "the re-read's failure");

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(cell), _fixture.EmbedCell.ToString()), (failure.SourceRelativePath, failure.FormKey));
        Assert.NotNull(index.CopyIn(TemporaryRef, _fixture.Plugin));
    }
}
