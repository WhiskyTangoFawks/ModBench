using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// Delete and Renumber resolve containers through <see cref="SourceUnitResolver"/> — the same
/// record→source-unit resolution <see cref="RecordEditService.EditField"/> uses, not a blanket
/// <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/> refusal. Two shapes:
///
/// <list type="bullet">
/// <item><description>A container's own record (Cell/Worldspace/Quest, or a nested folder-split child
/// like a Quest's own DialogTopic) — delete removes its directory whole and cascades every embedded
/// or nested descendant's index row; renumber moves the directory to a new leaf name at the same
/// parent.</description></item>
/// <item><description>An embedded child (a placed ref, navmesh, landscape, a Worldspace's TopCell) —
/// delete splices it out of its owner's inline slot and rewrites the owner; renumber changes its
/// FormKey in place inside the owner's object graph, no file move.</description></item>
/// </list>
///
/// <see cref="Source.ContainerRecordRegressionTests"/> carries the read-path and
/// EditorID-rename coverage this suite is a sibling of.
/// </summary>
public sealed class RecordEditServiceContainerDeleteRenumberTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordIndex Index => _fixture.Mirror.Index!;

    // ---- a container's own record ----

    [Fact]
    public void DeletingAContainersOwnRecord_RemovesItsDirectory_AndCascadesEveryEmbeddedDescendantsIndexRow()
    {
        var directory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId))!;
        Assert.True(Directory.Exists(directory));

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(directory));

        // The container's own row, and every embedded child's — all four of EmbedCell's slots.
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.Navmesh.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.Landscape.ToString(), _fixture.Plugin));

        // Still at Head — this is a working-tree delete, not a hard erase.
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void DeletingAWorldspace_CascadesTwoLevelsDeep_ThroughItsEmbeddedTopCellToTheTopCellsOwnRef()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Worldspace.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.Worldspace.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
    }

    /// <summary>
    /// <c>EnumerateDescendantFormKeys</c> must not pick the worldspace's TopCell via
    /// <c>FirstOrDefault(c => c.BlockX == null)</c> — the same blind spot
    /// <see cref="Queries.WorldspaceQueryService.GetWorldspaceBlocks"/> guards against: a
    /// second block-less cell-location row (anomalous, but the data can't rule it out — see that
    /// method's own doc comment on why it only warns rather than refuses) never reaches the cascade
    /// at all. Real Mutagen can't produce this shape itself (<c>Worldspace.TopCell</c> is a single-valued
    /// slot), so the second row is injected at the <see cref="IRecordReads"/> seam —
    /// appended <b>after</b> the real TopCell row, so a <c>FirstOrDefault</c> implementation
    /// still finds the real TopCell (proving the existing single-row
    /// case is untouched) and the injected row's own descendants are exactly what the bug drops.
    /// <see cref="ContainerModFixture.EmbedCell"/> stands in for the injected row's FormKey because it
    /// already carries real indexed descendants of its own (<see cref="ContainerModFixture.TemporaryRef"/>,
    /// <see cref="ContainerModFixture.PersistentRef"/>) that
    /// <see cref="DeletingAContainersOwnRecord_RemovesItsDirectory_AndCascadesEveryEmbeddedDescendantsIndexRow"/>
    /// already proves <c>EnumerateDescendantFormKeys</c> reaches when called on it directly — so a
    /// failure here can only be the two-row enumeration itself, not some other gap in the recursion.
    /// </summary>
    [Fact]
    public void DeletingAWorldspace_WithTwoBlocklessCellRows_CascadesIntoBothCellsDescendants()
    {
        var realRows = Index.At(RecordRef.Effective).GetWorldspaceCells(_fixture.Plugin, _fixture.Worldspace.ToString());
        var extraRow = new CellLocationSummary(
            _fixture.EmbedCell.ToString(), ContainerModFixture.EmbedCellEditorId,
            BlockX: null, BlockY: null, SubX: null, SubY: null, CellX: null, CellY: null);

        var injectingIndex = new WorldspaceCellInjectingIndex(
            Index, _fixture.Worldspace.ToString(), [.. realRows, extraRow]);
        var mirror = new IndexOverridingMirror(_fixture.Mirror, injectingIndex);
        var service = new RecordEditService(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.DeleteRecord(_fixture.Plugin, _fixture.Worldspace.ToString());

        Assert.True(result.Applied, result.Message);
        // The real TopCell's own descendants — unaffected by the second row's presence, proving the
        // existing single-block-less-row behavior is unchanged.
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        // The injected second block-less row's own descendants — exactly what a FirstOrDefault
        // implementation drops, since it stops at the first (real) row above.
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
    }

    /// <summary>Intercepts only <see cref="IRecordReads.GetWorldspaceCells"/> — everything else
    /// stays the real DuckDB-backed behavior, per <see cref="DelegatingRecordIndex"/>'s own posture of
    /// "one seam intercepted, not a fake database". #639 moved every read off <see cref="IRecordIndex"/>
    /// itself onto whatever <see cref="IRecordIndex.At"/> hands out, so the interception moves with
    /// it — <see cref="WorldspaceCellInjectingIndex"/> overrides <c>At</c> to return a
    /// <see cref="DelegatingReads"/> that intercepts just this one member, rather than overriding the
    /// member directly (no longer possible: <see cref="IRecordIndex"/> no longer declares it).</summary>
    private sealed class WorldspaceCellInjectingIndex(
        IRecordIndex inner, string worldspaceFormKey, IReadOnlyList<CellLocationSummary> rows)
        : DelegatingRecordIndex(inner)
    {
        public override IRecordReads At(RecordRef recordRef) =>
            new WorldspaceCellInjectingReads(base.At(recordRef), worldspaceFormKey, rows);

        private sealed class WorldspaceCellInjectingReads(
            IRecordReads inner, string worldspaceFormKey, IReadOnlyList<CellLocationSummary> rows)
            : DelegatingReads(inner)
        {
            public override IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKeyArg) =>
                worldspaceFormKeyArg == worldspaceFormKey ? rows : base.GetWorldspaceCells(plugin, worldspaceFormKeyArg);
        }
    }

    // ---- an embedded child ----

    [Fact]
    public void DeletingAnEmbeddedListChild_RemovesItFromTheOwnersInlineList_AndRewritesTheOwnersDocument_LeavingSiblingsIntact()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        Assert.Contains(ContainerModFixture.TemporaryRefEditorId, before, StringComparison.Ordinal);

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModFixture.TemporaryRefEditorId, after, StringComparison.Ordinal);
        // Untouched siblings in the same document.
        Assert.Contains(ContainerModFixture.PersistentRefEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModFixture.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModFixture.LandscapeEditorId, after, StringComparison.Ordinal);

        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        // The owner's own row picked up the rewritten body.
        Assert.DoesNotContain(
            ContainerModFixture.TemporaryRefEditorId,
            Index.At(RecordRef.Effective).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body!,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The single-value-slot half of the same mechanism — <c>Worldspace.TopCell</c> is not a list,
    /// so removal is "set the property to null", a distinct branch from the list splice above with
    /// zero coverage otherwise.
    ///
    /// <para><c>Cell.Landscape</c>/<c>NavigationMeshes</c> cannot stand in for this: per
    /// <see cref="ContainerModFixture"/>'s own doc comment, <c>land</c>/<c>navm</c> have no published
    /// schema at all, so <c>index.GetDocument</c> already answers null for them before
    /// <see cref="RecordEditService.DeleteRecord"/> gets anywhere near the embedded-slot machinery —
    /// the same reason no test can <c>EditField</c> them either. <c>Worldspace.TopCell</c> is a Cell,
    /// which is fully reflected, so this is the one single-value embedded slot actually reachable
    /// through the public gesture.</para>
    /// </summary>
    [Fact]
    public void DeletingASingleValueEmbeddedSlot_NullsTheSlot_AndCascadesItsOwnDescendant()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId);
        Assert.Contains(ContainerModFixture.TopCellEditorId, File.ReadAllText(file), StringComparison.Ordinal);

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.TopCell.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModFixture.TopCellEditorId, after, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModFixture.TopCellRefEditorId, after, StringComparison.Ordinal);

        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        // TopCellRef was itself embedded inside TopCell — cascaded, not orphaned.
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        // The Worldspace itself is untouched — only its TopCell slot emptied.
        Assert.NotNull(Index.At(RecordRef.Effective).GetDocument(_fixture.Worldspace.ToString(), _fixture.Plugin));
    }

    // ---- renumber a container's own record ----

    [Fact]
    public void RenumberingAContainersOwnRecord_MovesItsDirectoryToTheNewFormKey_AtTheSameParent()
    {
        var oldDirectory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.CellEditorId))!;
        var parent = Path.GetDirectoryName(oldDirectory)!;

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));

        var newDoc = Index.At(RecordRef.Effective).GetDocument(result.NewFormKey!, _fixture.Plugin);
        Assert.NotNull(newDoc);
        Assert.Contains(result.NewFormKey!, newDoc!.Body!, StringComparison.Ordinal);

        var newFile = _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);
        Assert.Equal(parent, Path.GetDirectoryName(Path.GetDirectoryName(newFile)));
    }

    // ---- renumber an embedded child ----

    [Fact]
    public void RenumberingAnEmbeddedChild_ChangesItsFormKeyInPlace_NoFileMoves_SameOwnerFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());

        Assert.True(result.Applied, result.Message);
        // Same file — an embedded record has no leaf of its own to move.
        Assert.Equal(file, _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId));
        var text = File.ReadAllText(file);
        Assert.Contains(result.NewFormKey!, text, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.TemporaryRef.ToString(), text, StringComparison.Ordinal);

        Assert.Null(Index.At(RecordRef.Effective).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Effective).GetDocument(result.NewFormKey!, _fixture.Plugin));
    }

    // ---- renumbering a record a container references ----

    [Fact]
    public void RenumberingARecordReferencedByAContainer_RewritesTheContainersOwnFileCleanly()
    {
        // A self-contained mod rather than the shared fixture: none of ContainerModFixture's own
        // embedded refs point anywhere, and giving one a real Base here — the one relationship this
        // test needs — is a bigger, riskier change to a fixture 4+ other suites depend on than a
        // small local one.
        const string pluginName = "ContainerReferencer.esp";
        const string origin = "ContainerReferencerMod";
        var modFolder = Directory.CreateTempSubdirectory("medit-container-referencer-mod-").FullName;
        var gameDirectory = Directory.CreateTempSubdirectory("medit-container-referencer-game-").FullName;
        try
        {
            var pluginPath = Path.Combine(modFolder, pluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
            var npc = mod.Npcs.AddNew("ReferencedNpc");
            var cell = new Cell(mod) { EditorID = "ReferencerCell", WaterHeight = 0f };
            var placedRef = new PlacedObject(mod) { EditorID = "ReferencerRef", Position = new Noggog.P3Float(0, 0, 0) };
            placedRef.Base.SetTo(npc.FormKey);
            cell.Temporary.Add(placedRef);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            mod.Cells.Records.Add(block);
            mod.WriteToBinary(pluginPath);

            using var mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            var plugin = new PluginKey(pluginName, origin);
            ((ILoadOrderMirror)mirror).Reconcile(
                gameDirectory, [new LoadOrderEntry(pluginName, pluginPath, origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);
            Track(mirror, origin);

            var file = Directory.EnumerateFiles(
                    Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName)), "RecordData.json", SearchOption.AllDirectories)
                .Single(f => File.ReadAllText(f).Contains("\"ReferencerRef\"", StringComparison.Ordinal));
            Assert.Contains(npc.FormKey.ToString(), File.ReadAllText(file), StringComparison.Ordinal);

            var result = new RecordEditService(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
                .RenumberRecord(plugin, npc.FormKey.ToString());

            Assert.True(result.Applied, result.Message);
            var text = File.ReadAllText(file);
            Assert.DoesNotContain(npc.FormKey.ToString(), text, StringComparison.Ordinal);
            Assert.Contains(result.NewFormKey!, text, StringComparison.Ordinal);
        }
        finally
        {
            TryDelete(modFolder);
            TryDelete(gameDirectory);
        }
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    // Not inlined into the [Fact] above: xUnit1031 flags a blocking Task wait directly inside a test
    // method, the same reason ContainerModFixture's own TrackAsync call lives in its constructor
    // rather than in a test body.
    private static void Track(LoadOrderMirror mirror, string origin) =>
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(mirror.LoadOrder!, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    // ---- order preservation ----

    /// <summary>
    /// "Delete/create a mid-list embedded child ... assert surviving GRUP order", on a
    /// container-nested folder-split list (<c>Quest.DialogTopics</c>) rather than a flat top-level one.
    /// Renumber <i>is</i> "delete the old file, create the new one" for the same child,
    /// so renumbering the middle of three DialogTopics exercises exactly "delete then
    /// create a mid-list embedded child" in one gesture.
    ///
    /// <para><b>A renumber keeps the record where it was.</b> Order lives in the parent's own ordered
    /// child list (ADR-0042 decision 4), keyed by FormKey — so a renumber repoints that one entry in
    /// place rather than moving the record to the end of the list, which is what the superseded
    /// numbering scheme did by treating a renumber as delete-then-append. For
    /// <c>DialogTopic.Responses</c> that difference is gameplay, not cosmetics. This asserts both
    /// halves: the parent's list directly, and that a compile of the result reproduces the same order
    /// in the binary (which the list alone does not prove).</para>
    /// </summary>
    [Fact]
    public void RenumberingAMidListFolderSplitChild_RenormalizesSurvivingSiblingsToContiguousSlots_AndCompiles()
    {
        var dialogTopicsDirectory = Path.GetDirectoryName(
            Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId)))!;
        Assert.Equal("DialogTopics", Path.GetFileName(dialogTopicsDirectory));

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(result.Applied, result.Message);

        // The quest's own document is what carries its DialogTopics' order now — not the child
        // directory names, which carry identity and nothing else.
        var questDirectory = Path.GetDirectoryName(dialogTopicsDirectory)!;
        var order = SourceChildOrder.ListAt(
            SourceChildOrder.CarrierFor(questDirectory, parentIsRecord: true), "DialogTopics");

        Assert.Equal(3, order.Count);
        // Every sibling stays exactly where it was: the two untouched ones are not renamed, not
        // renumbered, and not moved in the list, and the renumbered record holds its own middle slot
        // under its new FormKey rather than being appended past its siblings.
        Assert.Equal(_fixture.DialogTopic.ToString(), order[0]);
        Assert.Equal(result.NewFormKey, order[1]);
        Assert.Equal(_fixture.DialogTopic3.ToString(), order[2]);

        // And the directory names themselves carry no position at all.
        var names = Directory.EnumerateDirectories(dialogTopicsDirectory).Select(Path.GetFileName).ToList();
        Assert.Equal(3, names.Count);
        Assert.All(names, n => Assert.DoesNotContain("[", n!, StringComparison.Ordinal));

        // The promise: this compiles, and the compiled binary's DialogTopics are in exactly the
        // order the quest's document records.
        var compileResult = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest);
        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic2EditorId, ContainerModFixture.DialogTopic3EditorId],
            quest.DialogTopics.Select(t => t.EditorID!).ToArray());
    }

}
