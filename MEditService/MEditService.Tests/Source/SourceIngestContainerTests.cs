using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// Ingest-from-source at the container seam: a Cell's <b>embedded</b> children — the placed
/// references written inline into the parent document rather than as files of their own — are still
/// their own queryable records after a tracked plugin is ingested from its source tree, at both refs.
///
/// <para>Runs against the shared <see cref="ContainerModFixture"/> rather than a local Cell
/// fixture of its own — the shared <c>TrackedModFixture</c> holds Npc/Race/Keyword and no containers
/// at all, so it structurally cannot exercise any of this, which is exactly how a container
/// regression once shipped with no test able to see it.
/// (<c>SourceIngestParityTests</c> covers the same ground across 2,577 real records; this suite is the
/// fast, readable statement of the specific property.)</para>
/// </summary>
public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderMirror NewLoadOrder()
    {
        var mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)mirror).Reconcile(
            _fixture.GameDirectory,
            [new LoadOrderEntry(ContainerModFixture.PluginName, Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName), ContainerModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return mirror;
    }

    // ---- Embedded children survive the round trip through the tree ----

    [Fact]
    public void AnEmbeddedPlacedReference_IsItsOwnRecord_AfterIngestFromSource()
    {
        using var reloaded = NewLoadOrder();

        var record = reloaded.Index!.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(record);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, record!.EditorId);
        Assert.NotNull(reloaded.Index!.Resolve(_fixture.TemporaryRef.ToString()));
    }

    [Fact]
    public void AnEmbeddedPlacedReference_KeepsItsPlacementRow_AfterIngestFromSource()
    {
        using var reloaded = NewLoadOrder();

        var placement = reloaded.Index!.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(placement);
        // The spatial facts survive containment being expressed as a directory rather than a GRUP.
        Assert.Equal(_fixture.EmbedCell.ToString(), placement!.Value.ParentCell);
        Assert.Equal(11f, placement.Value.PosX);
    }

    [Fact]
    public void AnEmbeddedPlacedReference_AnswersAtBothRefs_OnACleanTree()
    {
        using var reloaded = NewLoadOrder();

        // Nothing is dirty, so the one parse serves both refs — ADR-0041's clean fast path, asserted
        // rather than assumed, and asserted for a record that exists only inside its parent's document.
        var effective = reloaded.Index!.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(head);
        Assert.Equal(effective!.Body, head!.Body);
    }

    [Fact]
    public void TheCellItself_AnswersAfterIngestFromSource()
    {
        using var reloaded = NewLoadOrder();

        var cell = reloaded.Index!.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(cell);
        Assert.Equal(ContainerModFixture.EmbedCellEditorId, cell!.EditorId);
        // The child is embedded in the parent's document, which is what gives it no file of its own.
        Assert.Contains(ContainerModFixture.TemporaryRefEditorId, cell.Body, StringComparison.Ordinal);
    }

    // ---- Container Head reconciliation ----

    /// <summary>
    /// A container edited in the working tree is read correctly at Effective and also reconciles at
    /// <b>Head</b>.
    ///
    /// <para><c>SourceIngest.ReconcileHead</c> identifies a dirty source unit through
    /// <see cref="SourceRecordPath.TryParse"/>, which fails closed for every container path by
    /// design — recovering a record type from <c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c>
    /// needs a structure-aware reader, and ADR-0041's 2026-08-23 amendment rules that reader out
    /// permanently. On that parse failure a dirty path under the plugin's own tree falls through to
    /// <c>SourceIngest.ReconcileHeadStructurally</c>, which deserializes <c>HEAD</c> the same
    /// whole-mod way Effective already was and diffs the two mod objects by FormKey — no path
    /// grammar involved.</para>
    /// </summary>
    [Fact]
    public void AnExternallyEditedContainer_ReconcilesItsHeadState_ThroughStructuralDiff()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerModFixture.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder();

        // The load completed and the edit is visible — no throw, no dropped plugin, no fallback.
        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedCell", reloaded.Index!.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);

        // Head now holds the true, pre-edit baseline — not Effective's own value.
        Assert.Equal(
            ContainerModFixture.EmbedCellEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);
    }

    /// <summary>The positive control for the test above: a <i>flat</i> record edited in the same tree
    /// also reconciles, so this mechanism is uniform across flat and container records rather than the
    /// container being a special case.</summary>
    [Fact]
    public void AFlatRecordEditedBesideTheContainer_DoesReconcileItsHead()
    {
        // Resolved through SourceUnitResolver rather than SourceRecordPath.For directly — For
        // needs an order index this test has no reason to track.
        var npcFile = SourceUnitResolver.FlatSourcePath(
            _fixture.ModFolder, ContainerModFixture.PluginName, "npc_", _fixture.Npc.ToString(),
            ContainerModFixture.NpcEditorId, GameRelease.Fallout4);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerModFixture.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder();

        Assert.Equal("RenamedNpc", reloaded.Index!.GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(
            ContainerModFixture.NpcEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
    }

    /// <summary>Not the container itself, but one of its
    /// <b>embedded children</b> — <see cref="ContainerModFixture.TemporaryRef"/> has no file of its own
    /// (it lives inline in <see cref="ContainerModFixture.EmbedCell"/>'s document), so this exercises
    /// the structural diff finding a divergent FormKey <i>inside</i> a container's body, not just the
    /// container's own top-level fields.</summary>
    [Fact]
    public void AnEmbeddedChildEditedInPlace_ReconcilesItsOwnHeadState()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                $"\"EditorID\": \"{ContainerModFixture.TemporaryRefEditorId}\"",
                "\"EditorID\": \"RenamedTempRef\"", StringComparison.Ordinal));

        using var reloaded = NewLoadOrder();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal(
            "RenamedTempRef",
            reloaded.Index!.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(
            ContainerModFixture.TemporaryRefEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin)!.EditorId);
    }

    /// <summary>A structural <b>creation</b>: a brand-new embedded child added to the working tree,
    /// never committed. Exercises <c>ReconcileHeadStructurally</c>'s "present in Effective, absent from
    /// HEAD" branch (<see cref="IRecordIndex.MarkWorkingTreeOnly"/>) — the record must answer at
    /// Effective and be absent at Head, the mirror image of the deletion test below.</summary>
    [Fact]
    public void AnEmbeddedChildAddedInTheWorkingTree_AnswersOnlyAtEffective()
    {
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

        using var reloaded = NewLoadOrder();

        Assert.Empty(reloaded.Status.Failures);
        var effective = reloaded.Index!.GetDocument(newFormKey, _fixture.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("BrandNewRef", effective!.EditorId);
        Assert.Null(reloaded.Index!.At(RecordRef.Head).GetDocument(newFormKey, _fixture.Plugin));
    }

    /// <summary>A structural <b>deletion</b>: an embedded child removed from the working tree without
    /// being committed. Exercises <c>ReconcileHeadStructurally</c>'s "present in HEAD, absent from
    /// Effective" branch (<see cref="IRecordIndex.SeedCommittedOnly"/>), including the record-type
    /// round trip that branch alone needs (<c>SourceRecordType.Resolve</c>, since a deletion has no
    /// working-tree file left to read a type off) — Head must answer with the record intact, not throw
    /// and not answer with the wrong shape.</summary>
    [Fact]
    public void AnEmbeddedChildDeletedInTheWorkingTree_AnswersOnlyAtHead()
    {
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

        using var reloaded = NewLoadOrder();

        Assert.Empty(reloaded.Status.Failures);
        Assert.Null(reloaded.Index!.GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));

        var atHead = reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin);
        Assert.NotNull(atHead);
        Assert.Equal(ContainerModFixture.PersistentRefEditorId, atHead!.EditorId);
    }
}
