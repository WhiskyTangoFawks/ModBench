using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// #452 AC3 at the container seam: a Cell's <b>embedded</b> children — the placed references Spriggit
/// writes inline into the parent document rather than as files of their own — are still their own
/// queryable records after a tracked plugin is ingested from its source tree, at both refs.
///
/// <para>Runs against the shared <see cref="ContainerModFixture"/> (#466) rather than a local Cell
/// fixture of its own — the shared <c>TrackedModFixture</c> holds Npc/Race/Keyword and no containers
/// at all, so it structurally cannot exercise any of this, which is exactly how #451 shipped a
/// container regression no test could see; <see cref="ContainerModFixture"/> is the consolidated
/// answer to that gap, covering the same ground this suite always needed (an embedded placed ref, a
/// flat record beside it) plus what its siblings needed.
/// (<c>SourceIngestParityTests</c> covers the same ground across 2,577 real records; this suite is the
/// fast, readable statement of the specific property.)</para>
/// </summary>
public sealed class SourceIngestContainerTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private SessionManager NewSession()
    {
        var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            _fixture.GameDirectory,
            [new ExplicitPluginInput(
                ContainerModFixture.PluginName,
                Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName),
                ContainerModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);
        return sessions;
    }

    // ---- AC3: embedded children survive the round trip through the tree ----

    [Fact]
    public void AnEmbeddedPlacedReference_IsItsOwnRecord_AfterIngestFromSource()
    {
        using var reloaded = NewSession();

        var record = reloaded.Index!.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(record);
        Assert.Equal(ContainerModFixture.TemporaryRefEditorId, record!.EditorId);
        Assert.NotNull(reloaded.Index!.Resolve(_fixture.TemporaryRef.ToString()));
    }

    [Fact]
    public void AnEmbeddedPlacedReference_KeepsItsPlacementRow_AfterIngestFromSource()
    {
        using var reloaded = NewSession();

        var placement = reloaded.Index!.GetPlacement(_fixture.TemporaryRef.ToString(), _fixture.Plugin);
        Assert.NotNull(placement);
        // The spatial facts survive containment being expressed as a directory rather than a GRUP.
        Assert.Equal(_fixture.EmbedCell.ToString(), placement!.Value.ParentCell);
        Assert.Equal(11f, placement.Value.PosX);
    }

    [Fact]
    public void AnEmbeddedPlacedReference_AnswersAtBothRefs_OnACleanTree()
    {
        using var reloaded = NewSession();

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
        using var reloaded = NewSession();

        var cell = reloaded.Index!.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin);
        Assert.NotNull(cell);
        Assert.Equal(ContainerModFixture.EmbedCellEditorId, cell!.EditorId);
        // The child is embedded in the parent's document, which is what gives it no file of its own.
        Assert.Contains(ContainerModFixture.TemporaryRefEditorId, cell.Body, StringComparison.Ordinal);
    }

    // ---- The pinned #463 limitation ----

    /// <summary>
    /// A container edited in the working tree is read correctly at Effective, but its <b>Head</b> state
    /// is not reconciled — so it reads <i>clean</i> when it is in fact dirty.
    ///
    /// <para>This is a known, bounded gap, pinned here rather than left silent.
    /// <c>SourceIngest.ReconcileHead</c> identifies a dirty source unit through
    /// <see cref="SourceRecordPath.TryParse"/>, which fails closed for every container path by design:
    /// recovering a record type from <c>Cells/&lt;b&gt;/&lt;sb&gt;/&lt;name&gt;/RecordData.json</c> or
    /// <c>Quests/&lt;n&gt;/DialogTopics/&lt;n&gt;/RecordData.json</c> needs a structure-aware reader —
    /// a Quest's own directory and its DialogTopics children share a group-folder segment, so position
    /// alone cannot tell them apart. It degrades and logs; it never throws, which is the part that
    /// matters for a session load.</para>
    ///
    /// <para><b>#463's, and it has been misattributed twice — do not move it again without reading
    /// this.</b> #453 said "#453/#454"; #453's own landing narrowed that to "#454's", on the premise
    /// that compile-reads-structure-from-the-tree would have to build a path → record-identity reader
    /// this could reuse. #454 landed and built no such thing: compile hands the whole tree to the
    /// generated whole-mod deserializer, which walks the directory structure itself, so there is no
    /// path grammar anywhere in it to borrow. Neither resolver direction produced one — #453 needed
    /// only FormKey → path, which <c>SourceUnitResolver</c> answers by finding the file on disk. The
    /// gap therefore survived #454 untouched and now has a ticket of its own, <b>#463</b>, carrying
    /// both candidate directions — including reconciling Head <i>structurally</i> (deserialize the
    /// <c>HEAD</c> tree and diff mod objects), which needs no grammar at all and is affordable on
    /// #452's own measurements.</para>
    ///
    /// <para>Note what #453 did change about the neighbouring case: a <i>flat</i> record renamed by an
    /// EditorID edit now reconciles correctly across a reload rather than landing in both halves of
    /// <c>records_head</c> (<c>SourceIngestTests.AnEditorIdRename_ReadsAsOneDirtyRecordAfterReload_NotACreateAndADelete</c>).
    /// A renamed <i>container</i> still does not, for the reason above.</para>
    ///
    /// <para>When #463 lands, this test should go red and be replaced by the real assertion (Head holds
    /// the committed bytes). That is the intended lifecycle, not a regression.</para>
    /// </summary>
    [Fact]
    public void AnExternallyEditedContainer_IsCorrectAtEffective_ButItsHeadStateIsNotYetReconciled()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(ContainerModFixture.EmbedCellEditorId, "RenamedCell", StringComparison.Ordinal));

        using var reloaded = NewSession();

        // The load completed and the edit is visible — no throw, no dropped plugin, no fallback.
        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal("RenamedCell", reloaded.Index!.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);

        // The gap: Head should hold the pre-edit EditorID and does not, because the container's dirty
        // path was skipped by the reconciliation pass. Asserted as-is so the day it changes, we are told.
        Assert.Equal(
            "RenamedCell",
            reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.EditorId);
    }

    /// <summary>The positive control for the test above: a <i>flat</i> record edited in the same tree
    /// does reconcile, so "Head was not reconciled" is specific to containers rather than the
    /// reconciliation pass being broken outright.</summary>
    [Fact]
    public void AFlatRecordEditedBesideTheContainer_DoesReconcileItsHead()
    {
        // #459: resolved through SourceUnitResolver rather than SourceRecordPath.For directly — For
        // now needs an order index this test has no reason to track.
        var npcFile = SourceUnitResolver.FlatSourcePath(
            _fixture.ModFolder, ContainerModFixture.PluginName, "npc_", _fixture.Npc.ToString(),
            ContainerModFixture.NpcEditorId, GameRelease.Fallout4);
        File.WriteAllText(
            npcFile,
            File.ReadAllText(npcFile).Replace(ContainerModFixture.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        using var reloaded = NewSession();

        Assert.Equal("RenamedNpc", reloaded.Index!.GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
        Assert.Equal(
            ContainerModFixture.NpcEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(_fixture.Npc.ToString(), _fixture.Plugin)!.EditorId);
    }
}
