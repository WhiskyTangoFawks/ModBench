using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Records;

public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Reloaded() => Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

    [Fact]
    public void AnExternallyEditedContainer_ServesItsEdit_ThroughStructuralDiff()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerModPlugin.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        var effective = reloaded.RequireReads().GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedCell", effective.EditorId);
    }

    [Fact]
    public void AFlatRecordEditedBesideTheContainer_ServesItsEdit()
    {
        var npcFile = _fixture.SourceFileContaining(ContainerMod.NpcEditorId);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerMod.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        var effective = reloaded.RequireReads().GetDocument(_fixture.Npc.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedNpc", effective.EditorId);
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
        var effective = reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedTempRef", effective.EditorId);
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
        var effective = reloaded.RequireReads().GetDocument(newFormKey, _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("BrandNewRef", effective.EditorId);
        Assert.True(reloaded.RequireReads().StackEntry(newFormKey, _fixture.Plugin).Require().HasWorkingTreeChange);
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
        Assert.Null(reloaded.RequireReads().GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.NotNull(reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void AnEmbeddedChildNamingATypeTheGameLacks_FailsTheSourceRead_NamingTheChild()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(file, WithTemporaryRefMisspelt(File.ReadAllText(file)));

        using var reloaded = Reloaded();

        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(ContainerMod.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.Ordinal);
        Assert.Contains(_fixture.TemporaryRef.ToString(), failure.Reason, StringComparison.Ordinal);
        Assert.Contains("PlacedObjekt", failure.Reason, StringComparison.Ordinal);
        Assert.Contains(file, failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AContainerEditedAfterTheReadToNameATypeTheGameLacks_FailsTheSourceRead_AndKeepsTheContainersLastGoodRows()
    {
        using var index = Reloaded();
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        File.WriteAllText(file, WithTemporaryRefMisspelt(File.ReadAllText(file)));

        index.NextSnapshotUntil(() => index.Status.Failures.Count > 0, "the plugin's failure");

        var failure = Assert.Single(index.Status.Failures);
        Assert.Contains(_fixture.TemporaryRef.ToString(), failure.Reason, StringComparison.Ordinal);
        Assert.DoesNotContain(
            "PlacedObjekt",
            index.RequireReads().DocumentOf(_fixture.EmbedCell.ToString(), _fixture.Plugin).BodyOf(),
            StringComparison.Ordinal);
    }

    private static string WithTemporaryRefMisspelt(string cellDocument)
    {
        var temporaryChild = ObjectEnclosingTheLineNaming(cellDocument, ContainerModPlugin.TemporaryRefEditorId);
        var misspelt = cellDocument.Replace(
            temporaryChild,
            temporaryChild.Replace("\"PlacedObject\"", "\"PlacedObjekt\"", StringComparison.Ordinal),
            StringComparison.Ordinal);
        Assert.NotEqual(cellDocument, misspelt);
        return misspelt;
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
