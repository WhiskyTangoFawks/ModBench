using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

/// <summary>
/// #452 / ADR-0041's #444 amendment, point 2: "Tracked plugins ingest from source. Working tree →
/// Effective, git <c>HEAD</c> → Head; the binary is never consulted for a tracked plugin's content."
///
/// <para>Every test here reloads the mod folder in a <b>brand-new</b> <see cref="SessionManager"/> —
/// the only honest way to ask what session load itself ingests, rather than what some earlier
/// in-session gesture left behind. And every assertion reads the raw <see cref="IRecordIndex"/>,
/// never <c>RecordQueryService</c>: the latter drives <c>SourceFreshness</c>'s read-time self-heal,
/// which would fold the source file in on the first read and make a binary-seeded ingest look
/// source-seeded. The point of this suite is that no point-read trigger is needed at all.</para>
/// </summary>
public sealed class SourceIngestTests
{
    /// <summary>A fresh session over the same mod folder — a backend restart, in effect.</summary>
    private static SessionManager Reload(TrackedModFixture mod)
    {
        var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            mod.GameDirectory,
            [new ExplicitPluginInput(
                TrackedModFixture.PluginName,
                Path.Combine(mod.ModFolder, TrackedModFixture.PluginName),
                TrackedModFixture.ModFolderOrigin,
                true)],
            GameRelease.Fallout4);
        return sessions;
    }

    // ---- AC1: the working tree is Effective ----

    [Fact]
    public void AnExternalEditToASourceFile_IsAtEffectiveAfterReload_WithNoPointRead()
    {
        using var mod = TrackedModFixture.Tracked();

        // A hand edit outside Modbench — the user's own editor, an agent's script, a git checkout.
        // Nothing tells the backend it happened; the next session load is simply expected to read it.
        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        var record = reloaded.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(record);
        Assert.Equal("ExternallyRenamed", record!.EditorId);
    }

    // ---- AC1: the #430/#432 reappearing-record gap, resolved by construction ----

    [Fact]
    public void AWorkingTreeDeletedRecord_IsAbsentAtEffectiveAfterReload()
    {
        using var mod = TrackedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(mod);

        Assert.Null(reloaded.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin));
        // Positive control: the load really happened and really indexed this plugin, or "absent"
        // would be true of a load that did nothing at all.
        Assert.NotNull(reloaded.Index!.GetDocument(mod.OtherNpc.ToString(), mod.Plugin));
    }

    /// <summary>
    /// The other half of the same deletion, and the reason it is not enough to simply leave the record
    /// out of the ingest: <c>HEAD</c> still holds it, so Head must still answer it. Without this the
    /// user could delete a record and then no longer see, diff or revert it — which is the centre of
    /// ADR-0041's git-native working-tree model, not an edge case.
    /// </summary>
    [Fact]
    public void AWorkingTreeDeletedRecord_StillAnswersAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        File.Delete(mod.NpcSourceFile);

        using var reloaded = Reload(mod);

        var head = reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin);
        Assert.NotNull(head);
        Assert.Equal(TrackedModFixture.NpcEditorId, head!.EditorId);
        // The Head row is HEAD's own bytes, not a reconstruction: same text `git show` serves.
        Assert.Equal(mod.GitShowHead(TrackedModFixture.RelativeSourcePath(
            mod.Npc, "npc_", TrackedModFixture.NpcEditorId)), head.Body);
    }

    // ---- AC2: HEAD is Head, the working tree is Effective, and they diverge ----

    [Fact]
    public void AnUncommittedEdit_LeavesHeadOnTheCommittedBytes_AndEffectiveOnTheWorkingTree()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        Assert.Equal("ExternallyRenamed", reloaded.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
        Assert.Equal(
            TrackedModFixture.NpcEditorId,
            reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
    }

    [Fact]
    public void AnEditCommittedOutsideModbench_LeavesBothRefsOnTheNewBytes_NotPermanentlyDirty()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "CommittedRename", StringComparison.Ordinal));
        var gitDir = Path.Combine(mod.ModFolder, ".git");
        GitCli.Run(gitDir, mod.ModFolder, "add", "-A");
        GitCli.Run(gitDir, mod.ModFolder, "commit", "-q", "-m", "external rename");

        using var reloaded = Reload(mod);

        // HEAD moved with the working tree, so the record is clean against its *new* baseline —
        // not dirty against a baseline no ref holds any more.
        Assert.Equal("CommittedRename", reloaded.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
        Assert.Equal(
            "CommittedRename",
            reloaded.Index!.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin)!.EditorId);
    }

    /// <summary>
    /// Reconciliation is <i>targeted</i>: the record whose file was edited reads dirty and its
    /// untouched sibling reads clean. Asserted at the listing seam (<see cref="RecordSummary.WorkingTreeState"/>
    /// — what the Plugins tree's own dirty decoration renders, #428) rather than by comparing two
    /// bodies, because "the two refs happen to hold equal bytes" is true of a great many wrong
    /// implementations, while "one is Modified and the other is None" is the distinction the ref
    /// dimension actually exists to make.
    /// </summary>
    [Fact]
    public void ReconcilingOneEditedRecord_LeavesItsUntouchedSiblingClean()
    {
        using var mod = TrackedModFixture.Tracked();

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace(
            TrackedModFixture.NpcEditorId, "ExternallyRenamed", StringComparison.Ordinal));

        using var reloaded = Reload(mod);

        var byFormKey = reloaded.Index!
            .Search(new RecordQuery { Plugin = TrackedModFixture.PluginName, Limit = 100 })
            .Items.ToDictionary(r => r.FormKey, StringComparer.Ordinal);

        Assert.Equal(WorkingTreeState.Modified, byFormKey[mod.Npc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.OtherNpc.ToString()].WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, byFormKey[mod.Race.ToString()].WorkingTreeState);
    }

    // ---- Q4: a source tree that cannot be read degrades to the binary, visibly ----

    [Fact]
    public void AnUnreadableSourceTree_FallsBackToTheBinary_AndSaysSoInTheSessionsFailures()
    {
        using var mod = TrackedModFixture.Tracked();

        // Never-assume-exclusive-ownership: MO2, a git operation, or the user can leave this tree
        // half-written at any moment. The root header is what the whole-mod door reads first.
        File.WriteAllText(
            Path.Combine(mod.ModFolder, $"{TrackedModFixture.PluginName}{SourceRecordPath.SourceSuffix}", "RecordData.json"),
            "{ this is not json");

        using var reloaded = Reload(mod);

        // Degraded, not dropped — the plugin's records are still queryable from the binary.
        Assert.NotNull(reloaded.Index!.GetDocument(mod.Npc.ToString(), mod.Plugin));

        // ...and the degradation is *visible*, which is the whole mitigation: a user reading
        // pre-Track binary content while believing they are reading their tracked source is the hazard.
        var failure = Assert.Single(reloaded.Status.Failures);
        Assert.Equal(TrackedModFixture.PluginName, failure.Name);
        Assert.Contains("source tree", failure.Reason, StringComparison.OrdinalIgnoreCase);
    }
}
