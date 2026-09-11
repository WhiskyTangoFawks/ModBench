using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>Runs against <see cref="ContainerModFixture"/>: the flat fixture holds no containers,
/// which is how a container regression once shipped unseen. <c>SourceIngestParityTests</c> covers
/// the same ground at scale.</summary>
public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IndexProjector NewLoadOrder(LoadOrderHolder holder)
    {
        var index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        index.Reconcile(holder,
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return index;
    }

    // ---- Embedded children survive the round trip through the tree ----

    [Fact]
    public void AnEmbeddedPlacedReference_IsItsOwnRecord_AfterIngestFromSource()
    {
        var holder = new LoadOrderHolder();
        using var reloaded = NewLoadOrder(holder);

        var record = reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(record);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, record!.EditorId);
        Assert.NotNull(reloaded.Store!.At(RecordRef.Effective).Resolve(_fixture.TemporaryRef.ToString()));
    }

    [Fact]
    public void AnEmbeddedPlacedReference_KeepsItsPlacementRow_AfterIngestFromSource()
    {
        var holder = new LoadOrderHolder();
        using var reloaded = NewLoadOrder(holder);

        var placement = reloaded.Store!.At(RecordRef.Effective).GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(placement);
        // The spatial facts survive containment being expressed as a directory rather than a GRUP.
        Assert.Equal(_fixture.EmbedCell.ToString(), placement!.Value.ParentCell);
        Assert.Equal(11f, placement.Value.PosX);
    }

    [Fact]
    public void AnEmbeddedPlacedReference_AnswersAtBothRefs_OnACleanTree()
    {
        var holder = new LoadOrderHolder();
        using var reloaded = NewLoadOrder(holder);

        // Nothing is dirty, so the one parse serves both refs — ADR-0007's clean fast path, asserted
        // rather than assumed, and asserted for a record that exists only inside its parent's document.
        var effective = reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        var head = reloaded.Store!.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(head);
        Assert.Equal(effective!.Body, head!.Body);
    }

    [Fact]
    public void TheCellItself_AnswersAfterIngestFromSource()
    {
        var holder = new LoadOrderHolder();
        using var reloaded = NewLoadOrder(holder);

        var cell = reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(cell);
        Assert.Equal(ContainerModFixture.EmbedCellEditorId, cell!.EditorId);
        // The child is embedded in the parent's document, which is what gives it no file of its own.
        Assert.Contains(ContainerModFixture.TemporaryRefEditorId, cell.Body, StringComparison.Ordinal);
    }

    // ---- Container Head reconciliation ----

    [Fact]
    public void AnExternallyEditedContainer_ReconcilesItsHeadState_ThroughStructuralDiff()
    {
        var holder = new LoadOrderHolder();
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerModFixture.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder(holder);

        // The load completed and the edit is visible — no throw, no dropped plugin, no fallback.
        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedCell", reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);

        // Head now holds the true, pre-edit baseline — not Effective's own value.
        Assert.Equal(
            ContainerModFixture.EmbedCellEditorId,
            reloaded.Store!.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);
    }

    [Fact]
    public void AFlatRecordEditedBesideTheContainer_DoesReconcileItsHead()
    {
        var holder = new LoadOrderHolder();
        // Asked of the repository rather than computed: the path needs an order index this test
        // has no reason to track.
        var npcFile = SourceDocumentPath.Of(
            _fixture.ModFolder, ContainerModFixture.PluginName, "npc_", _fixture.Npc.ToString(),
            ContainerModFixture.NpcEditorId, GameRelease.Fallout4);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerModFixture.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder(holder);

        Assert.Equal("RenamedNpc", reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(
            ContainerModFixture.NpcEditorId,
            reloaded.Store!.At(RecordRef.Head).GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
    }

    [Fact]
    public void AnEmbeddedChildEditedInPlace_ReconcilesItsOwnHeadState()
    {
        var holder = new LoadOrderHolder();
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                $"\"EditorID\": \"{ContainerModFixture.TemporaryRefEditorId}\"",
                "\"EditorID\": \"RenamedTempRef\"", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder(holder);

        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal(
            "RenamedTempRef",
            reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(
            ContainerModFixture.TemporaryRefEditorId,
            reloaded.Store!.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.EditorId);
    }

    [Fact]
    public void AnEmbeddedChildAddedInTheWorkingTree_AnswersOnlyAtEffective()
    {
        var holder = new LoadOrderHolder();
        const string newFormKey = "000900:ContainerFixture.esp";
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var withNewChild = original.Replace(
            """
              "Temporary": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000803:ContainerFixture.esp",
                  "EditorID": "TempRef",
                  "Scale": 1.0,
                  "Position": "11, 22, 33"
                }
              ]
            """,
            """
              "Temporary": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000803:ContainerFixture.esp",
                  "EditorID": "TempRef",
                  "Scale": 1.0,
                  "Position": "11, 22, 33"
                },
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000900:ContainerFixture.esp",
                  "EditorID": "BrandNewRef",
                  "Scale": 1.0,
                  "Position": "44, 55, 66"
                }
              ]
            """,
            StringComparison.Ordinal);
        Assert.NotEqual(original, withNewChild); // the replace actually matched — a guard against a silent no-op
        File.WriteAllText(file, withNewChild);

        using var reloaded = NewLoadOrder(holder);

        Assert.Empty(reloaded.Status.Failures);
        var effective = reloaded.Store!.At(RecordRef.Effective).GetDocument(newFormKey, _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("BrandNewRef", effective!.EditorId);
        Assert.Null(reloaded.Store!.At(RecordRef.Head).GetDocument(newFormKey, _fixture.Plugin));
    }

    [Fact]
    public void AnEmbeddedChildDeletedInTheWorkingTree_AnswersOnlyAtHead()
    {
        var holder = new LoadOrderHolder();
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var original = File.ReadAllText(file);
        var withoutPersistentChild = original.Replace(
            """
              "Persistent": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000804:ContainerFixture.esp",
                  "EditorID": "PersistRef",
                  "Scale": 4.0,
                  "Position": "1, 2, 3"
                }
              ]
            """,
            """  "Persistent": []""",
            StringComparison.Ordinal);
        Assert.NotEqual(original, withoutPersistentChild); // the replace actually matched
        File.WriteAllText(file, withoutPersistentChild);

        using var reloaded = NewLoadOrder(holder);

        Assert.Empty(reloaded.Status.Failures);
        Assert.Null(reloaded.Store!.At(RecordRef.Effective).GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));

        var atHead = reloaded.Store!.At(RecordRef.Head).GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin);
        Assert.NotNull(atHead);
        Assert.Equal(ContainerModFixture.PersistentRefEditorId, atHead!.EditorId);
    }
}
