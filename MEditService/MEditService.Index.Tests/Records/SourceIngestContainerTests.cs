using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>Runs against <see cref="ContainerMod"/>: the flat fixture holds no containers, which is
/// how a container regression once shipped unseen. <c>SourceIngestParityTests</c> covers the same
/// ground at scale.</summary>
public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IndexProjector Reloaded() => Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

    // ---- Embedded children survive the round trip through the tree ----

    [Fact]
    public void AnEmbeddedPlacedReference_IsItsOwnRecord_AfterIngestFromSource()
    {
        using var reloaded = Reloaded();

        var record = reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(record);
        Assert.Equal(ContainerMod.TemporaryRefEditorId, record.EditorId);
        Assert.NotNull(reloaded.RequireReads().Resolve(_fixture.TemporaryRef.ToString()));
    }

    [Fact]
    public void AnEmbeddedPlacedReference_KeepsItsPlacementRow_AfterIngestFromSource()
    {
        using var reloaded = Reloaded();

        var placement = reloaded.RequireReads().GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(placement);
        // The spatial facts survive containment being expressed as a directory rather than a GRUP.
        Assert.Equal(_fixture.EmbedCell.ToString(), placement.Value.ParentCell);
        Assert.Equal(11f, placement.Value.PosX);
    }

    [Fact]
    public void AnEmbeddedPlacedReference_AnswersAtBothRefs_OnACleanTree()
    {
        using var reloaded = Reloaded();

        // Nothing is dirty, so the one parse serves both refs — ADR-0007's clean fast path, asserted
        // rather than assumed, and asserted for a record that exists only inside its parent's document.
        var effective = reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        var head = reloaded.RequireReads().HeadDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.NotNull(head);
        Assert.Equal(effective.Body, head.Body);
    }

    [Fact]
    public void TheCellItself_AnswersAfterIngestFromSource()
    {
        using var reloaded = Reloaded();

        var cell = reloaded.RequireReads().GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(cell);
        Assert.Equal(ContainerMod.EmbedCellEditorId, cell.EditorId);
        // The child is embedded in the parent's document, which is what gives it no file of its own.
        Assert.Contains(ContainerMod.TemporaryRefEditorId, cell.Body, StringComparison.Ordinal);
    }

    // ---- Container Head reconciliation ----

    [Fact]
    public void AnExternallyEditedContainer_ReconcilesItsHeadState_ThroughStructuralDiff()
    {
        var file = _fixture.SourceFileContaining(ContainerMod.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerMod.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        // The load completed and the edit is visible — no throw, no dropped plugin, no fallback.
        Assert.Empty(reloaded.Status.Failures);
        var effective = reloaded.RequireReads().GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedCell", effective.EditorId);

        // Head now holds the true, pre-edit baseline — not Effective's own value.
        var head = reloaded.RequireReads().HeadDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(head);
        Assert.Equal(ContainerMod.EmbedCellEditorId, head.EditorId);
    }

    [Fact]
    public void AFlatRecordEditedBesideTheContainer_DoesReconcileItsHead()
    {
        var npcFile = _fixture.SourceFileContaining(ContainerMod.NpcEditorId);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerMod.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        var effective = reloaded.RequireReads().GetDocument(_fixture.Npc.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedNpc", effective.EditorId);
        var head = reloaded.RequireReads().HeadDocument(_fixture.Npc.ToString(), _fixture.Plugin);
        Assert.NotNull(head);
        Assert.Equal(ContainerMod.NpcEditorId, head.EditorId);
    }

    [Fact]
    public void AnEmbeddedChildEditedInPlace_ReconcilesItsOwnHeadState()
    {
        var file = _fixture.SourceFileContaining(ContainerMod.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                $"\"EditorID\": \"{ContainerMod.TemporaryRefEditorId}\"",
                "\"EditorID\": \"RenamedTempRef\"", StringComparison.Ordinal));

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        var effective = reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedTempRef", effective.EditorId);
        var head = reloaded.RequireReads().HeadDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(head);
        Assert.Equal(ContainerMod.TemporaryRefEditorId, head.EditorId);
    }

    [Fact]
    public void AnEmbeddedChildAddedInTheWorkingTree_AnswersOnlyAtEffective()
    {
        var newFormKey = $"000900:{ContainerMod.PluginName}";
        var file = _fixture.SourceFileContaining(ContainerMod.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var temporaryChild = ChildObject(original, ContainerMod.TemporaryRefEditorId);
        var withNewChild = original.Replace(
            temporaryChild,
            temporaryChild + ",\n" + temporaryChild
                .Replace(_fixture.TemporaryRef.ToString(), newFormKey, StringComparison.Ordinal)
                .Replace(ContainerMod.TemporaryRefEditorId, "BrandNewRef", StringComparison.Ordinal),
            StringComparison.Ordinal);
        Assert.NotEqual(original, withNewChild); // the replace actually matched — a guard against a silent no-op
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
        var file = _fixture.SourceFileContaining(ContainerMod.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var persistentChild = ChildObject(original, ContainerMod.PersistentRefEditorId);
        var withoutPersistentChild = original.Replace(persistentChild, string.Empty, StringComparison.Ordinal);
        Assert.NotEqual(original, withoutPersistentChild); // the replace actually matched
        File.WriteAllText(file, withoutPersistentChild);

        using var reloaded = Reloaded();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Null(reloaded.RequireReads().GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.NotNull(reloaded.RequireReads().GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    // The inlined child's own braces inside its owner's document, found by the line that names it and
    // walked out to the enclosing object, so the fixture's exact indentation is never spelled here.
    private static string ChildObject(string document, string editorId)
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
