using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Records;

public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Reloaded() => Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

    private SourceProblem TheOneSourceProblemOf(OpenedIndex index)
    {
        var problems = index.Problems.GetProblems().Value() ?? throw new InvalidOperationException("Expected the index to be ready.");
        return Assert.Single(Assert.Single(problems, p => PluginAddress.Comparer.Equals(p.Plugin, _fixture.Plugin)).Problems);
    }

    private bool ReadFromItsBinaryInPlaceOfItsSource(OpenedIndex index) =>
        index.PluginRowOf(_fixture.Plugin) is { IsTracked: true, PluginSourceUnreadable: not null };

    [Fact]
    public void AnExternallyEditedContainer_ServesItsEdit_ThroughStructuralDiff()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerModPlugin.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedCell", reloaded.DocumentOf(_fixture.EmbedCell.ToString(), _fixture.Plugin).EditorId);
    }

    [Fact]
    public void AFlatRecordEditedBesideTheContainer_ServesItsEdit()
    {
        var npcFile = _fixture.SourceFileContaining(ContainerMod.NpcEditorId);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerMod.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        Assert.Equal("RenamedNpc", reloaded.DocumentOf(_fixture.Npc.ToString(), _fixture.Plugin).EditorId);
    }

    [Fact]
    public void AnEmbeddedChildEditedInPlace_ServesItsEdit()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                $"\"EditorID\": \"{ContainerModPlugin.TemporaryRefEditorId}\"",
                "\"EditorID\": \"RenamedTempRef\"", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedTempRef", reloaded.DocumentOf(_fixture.TemporaryRef.ToString(), _fixture.Plugin).EditorId);
    }

    [Fact]
    public void AnEmbeddedChildAddedInTheWorkingTree_AnswersOnlyAtEffective()
    {
        var newFormKey = $"000900:{ContainerMod.PluginName}";
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var temporaryChild = ObjectEnclosingTheLineNaming(original, ContainerModPlugin.TemporaryRefEditorId);
        var withNewChild = original.Replace(
            temporaryChild,
            temporaryChild + ",\n" + temporaryChild
                .Replace(_fixture.TemporaryRef.ToString(), newFormKey, StringComparison.Ordinal)
                .Replace(ContainerModPlugin.TemporaryRefEditorId, "BrandNewRef", StringComparison.Ordinal),
            StringComparison.Ordinal);
        Assert.NotEqual(original, withNewChild);
        File.WriteAllText(file, withNewChild);

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("BrandNewRef", reloaded.DocumentOf(newFormKey, _fixture.Plugin).EditorId);
        Assert.Equal(WorkingTreeState.Added, reloaded.RowOf(newFormKey, _fixture.Plugin)?.WorkingTreeState);
    }

    [Fact]
    public void AnEmbeddedChildDeletedInTheWorkingTree_IsAbsentAtEffective()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var persistentChild = ObjectEnclosingTheLineNaming(original, ContainerModPlugin.PersistentRefEditorId);
        var withoutPersistentChild = original.Replace(persistentChild, string.Empty, StringComparison.Ordinal);
        Assert.NotEqual(original, withoutPersistentChild);
        File.WriteAllText(file, withoutPersistentChild);

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Null(reloaded.CopyIn(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.NotNull(reloaded.CopyIn(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    [Theory]
    [InlineData("\"PlacedObject\"", "\"PlacedObjekt\"", "a 'PlacedObjekt'")]
    [InlineData("\"MutagenObjectType\"", "\"MutagenObjectTypo\"", "with no 'MutagenObjectType'")]
    public void AnEmbeddedChildNoTypeResolves_LeavesThePluginSourceUnreadable_NamingTheChild_AndTheBinaryStillAnswersForIt(
        string spelled, string handEdited, string why)
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(file, WithTemporaryRefEdited(File.ReadAllText(file), spelled, handEdited));

        using var reloaded = Reloaded();

        var child = _fixture.TemporaryRef.ToString();
        Assert.NotNull(reloaded.CopyIn(child, _fixture.Plugin));
        Assert.NotNull(reloaded.RowOf(child, _fixture.Plugin));
        Assert.NotNull(reloaded.PlacementGroupIn(_fixture.Plugin, _fixture.EmbedCell.ToString(), child));
        Assert.True(ReadFromItsBinaryInPlaceOfItsSource(reloaded));
        Assert.Empty(reloaded.Status.Failures);
        var failure = TheOneSourceProblemOf(reloaded);
        Assert.Equal(Path.GetRelativePath(_fixture.Entry.ModFolderOf(), file), failure.SourceRelativePath);
        Assert.Contains(child, failure.Message, StringComparison.Ordinal);
        Assert.Contains(why, failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AContainerEditedAfterTheReadToNameATypeTheGameLacks_LeavesThePluginSourceUnreadable_AndTheBinaryAnswersForIt()
    {
        using var index = Reloaded();
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(file, WithTemporaryRefMisspelt(File.ReadAllText(file)));

        index.NextSnapshotUntil(
            () => ReadFromItsBinaryInPlaceOfItsSource(index),
            "the plugin file read in place of its source");

        Assert.Empty(index.Status.Failures);
        var failure = TheOneSourceProblemOf(index);
        Assert.Equal(_fixture.TemporaryRef.ToString(), failure.FormKey);
        Assert.Contains("a 'PlacedObjekt'", failure.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "PlacedObjekt",
            index.BodyOf(_fixture.EmbedCell.ToString(), _fixture.Plugin),
            StringComparison.Ordinal);
    }

    [Fact]
    public void AChildCommittedNamingATypeTheGameLacks_ThenFixedInTheWorkingTree_ReadsFine()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var fixedText = File.ReadAllText(file);
        File.WriteAllText(file, WithTemporaryRefMisspelt(fixedText));
        _fixture.Entry.Git("add", "-A");
        _fixture.Entry.Git("commit", "-q", "-m", "a hand edit committed");
        File.WriteAllText(file, fixedText);

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.NotNull(reloaded.CopyIn(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    private static string WithTemporaryRefMisspelt(string cellDocument) =>
        WithTemporaryRefEdited(cellDocument, "\"PlacedObject\"", "\"PlacedObjekt\"");

    private static string WithTemporaryRefEdited(string cellDocument, string from, string to)
    {
        var temporaryChild = ObjectEnclosingTheLineNaming(cellDocument, ContainerModPlugin.TemporaryRefEditorId);
        var edited = cellDocument.Replace(
            temporaryChild, temporaryChild.Replace(from, to, StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.NotEqual(cellDocument, edited);
        return edited;
    }

    private static string ObjectEnclosingTheLineNaming(string document, string editorId)
    {
        var at = document.IndexOf($"\"{editorId}\"", StringComparison.Ordinal);
        Assert.True(at >= 0, $"The container's document holds no child named '{editorId}'.");
        var start = document.LastIndexOf('{', at);
        var depth = 0;
        for (var i = start; i < document.Length; i++)
        {
            if (document[i] == '{') depth++;
            else if (document[i] == '}' && --depth == 0) return document[start..(i + 1)];
        }
        throw new InvalidOperationException($"The child named '{editorId}' has no closing brace.");
    }
}
