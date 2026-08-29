using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #461: Delete and Renumber widened off the blanket <see cref="RecordEditRefusal.ContainerRecordNotYetSupported"/>
/// refusal onto <see cref="SourceUnitResolver"/>, the same record→source-unit resolution #453 gave
/// <see cref="RecordEditService.EditField"/>. Two shapes, per the issue's own split:
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
/// <see cref="Source.ContainerRecordRegressionTests"/> carries the read-path (#453/#454) and
/// EditorID-rename (#453 scope 3) coverage this suite is a sibling of, plus the two refusal tests
/// this ticket flipped to success.
/// </summary>
public sealed class RecordEditServiceContainerDeleteRenumberTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordIndex Index => _fixture.Sessions.Index!;

    // ---- AC1: a container's own record ----

    [Fact]
    public void DeletingAContainersOwnRecord_RemovesItsDirectory_AndCascadesEveryEmbeddedDescendantsIndexRow()
    {
        var directory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId))!;
        Assert.True(Directory.Exists(directory));

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(directory));

        // The container's own row, and every embedded child's — all four of EmbedCell's slots.
        Assert.Null(Index.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.Navmesh.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.Landscape.ToString(), _fixture.Plugin));

        // Still at Head — this is a working-tree delete, not a hard erase.
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void DeletingAWorldspace_CascadesTwoLevelsDeep_ThroughItsEmbeddedTopCellToTheTopCellsOwnRef()
    {
        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.Worldspace.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(Index.GetDocument(_fixture.Worldspace.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
    }

    /// <summary>
    /// #496: <c>EnumerateDescendantFormKeys</c> picked the worldspace's TopCell via
    /// <c>FirstOrDefault(c => c.BlockX == null)</c> — the same shape #251 fixed in
    /// <see cref="Queries.WorldspaceQueryService.GetWorldspaceBlocks"/>, and the same blind spot: a
    /// second block-less cell-location row (anomalous, but the data can't rule it out — see #251's
    /// own doc comment on why it only warns rather than refuses) never reached the cascade at all.
    /// Real Mutagen can't produce this shape itself (<c>Worldspace.TopCell</c> is a single-valued
    /// slot), so the second row is injected at the <see cref="IRecordReads"/> seam exactly the way
    /// #251's own regression test fabricated it — appended <b>after</b> the real TopCell row, so the
    /// pre-fix <c>FirstOrDefault</c> still finds the real TopCell (proving the existing single-row
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
        var realRows = Index.GetWorldspaceCells(_fixture.Plugin, _fixture.Worldspace.ToString());
        var extraRow = new CellLocationSummary(
            _fixture.EmbedCell.ToString(), ContainerModFixture.EmbedCellEditorId,
            BlockX: null, BlockY: null, SubX: null, SubY: null, CellX: null, CellY: null);

        var injectingIndex = new WorldspaceCellInjectingIndex(
            Index, _fixture.Worldspace.ToString(), [.. realRows, extraRow]);
        var sessions = new IndexOverridingSessionManager(_fixture.Sessions, injectingIndex);
        var service = new RecordEditService(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.DeleteRecord(_fixture.Plugin, _fixture.Worldspace.ToString());

        Assert.True(result.Applied, result.Message);
        // The real TopCell's own descendants — unaffected by the second row's presence, proving the
        // existing single-block-less-row behavior is unchanged.
        Assert.Null(Index.GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        // The injected second block-less row's own descendants — this is what the pre-#496
        // FirstOrDefault dropped, since it stopped at the first (real) row above.
        Assert.Null(Index.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.Null(Index.GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
    }

    /// <summary>#496: intercepts only <see cref="IRecordIndex.GetWorldspaceCells"/> — everything else
    /// stays the real DuckDB-backed behavior, per <see cref="DelegatingRecordIndex"/>'s own posture of
    /// "one seam intercepted, not a fake database".</summary>
    private sealed class WorldspaceCellInjectingIndex(
        IRecordIndex inner, string worldspaceFormKey, IReadOnlyList<CellLocationSummary> rows)
        : DelegatingRecordIndex(inner)
    {
        public override IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKeyArg) =>
            worldspaceFormKeyArg == worldspaceFormKey ? rows : base.GetWorldspaceCells(plugin, worldspaceFormKeyArg);
    }

    /// <summary>#496: forwards every <see cref="ISessionManager"/> member to a real session except
    /// <see cref="Index"/>, which <see cref="RecordEditService"/> reads its <see cref="IRecordIndex"/>
    /// from — the only way to hand it an intercepted index, since <see cref="MEditService.Core.Session.SessionManager"/>'s
    /// own <c>Index</c> getter has no setter a test can reach.</summary>
    private sealed class IndexOverridingSessionManager(ISessionManager inner, IRecordIndex overrideIndex) : ISessionManager
    {
        public IGameSession? Session => inner.Session;
        public IRecordReads? Repository => inner.Repository;
        public IRecordIndex? Index => overrideIndex;
        public SessionStatus Status => inner.Status;
        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            inner.Load(dataFolderPath, pluginsTxtPath, gameRelease);
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) =>
            inner.LoadExplicit(gameDirectory, plugins, gameRelease);
        public void Unload() => inner.Unload();
        public PluginResponse CreatePlugin(string name, string path, string origin) => inner.CreatePlugin(name, path, origin);
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => inner.LoadUnlistedPlugin(path, origin);
        public void UnloadUnlistedPlugin(string plugin, string origin) => inner.UnloadUnlistedPlugin(plugin, origin);
        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) =>
            inner.RereadPlugin(plugin, newPath, newOrigin);
        public PluginResponse SetPluginParticipation(string plugin, bool participates) =>
            inner.SetPluginParticipation(plugin, participates);
        public Task ReindexPlugin(string plugin) => inner.ReindexPlugin(plugin);
        public Task ReindexPlugin(PluginKey key) => inner.ReindexPlugin(key);
        public void UnindexPlugin(PluginKey key) => inner.UnindexPlugin(key);
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => inner.ReindexPlugins(plugins);
        public void SetFilter(string sql) => inner.SetFilter(sql);
        public void ClearFilter() => inner.ClearFilter();
        public void ReapplyFilter() => inner.ReapplyFilter();
    }

    // ---- AC2: an embedded child ----

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

        Assert.Null(Index.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        // The owner's own row picked up the rewritten body.
        Assert.DoesNotContain(
            ContainerModFixture.TemporaryRefEditorId,
            Index.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin)!.Body!,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Q4: the single-value-slot half of the same mechanism — <c>Worldspace.TopCell</c> is not a list,
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

        Assert.Null(Index.GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        // TopCellRef was itself embedded inside TopCell — cascaded, not orphaned.
        Assert.Null(Index.GetDocument(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TopCell.ToString(), _fixture.Plugin));
        // The Worldspace itself is untouched — only its TopCell slot emptied.
        Assert.NotNull(Index.GetDocument(_fixture.Worldspace.ToString(), _fixture.Plugin));
    }

    // ---- AC3a: renumber a container's own record ----

    [Fact]
    public void RenumberingAContainersOwnRecord_MovesItsDirectoryToTheNewFormKey_AtTheSameParent()
    {
        var oldDirectory = Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.CellEditorId))!;
        var parent = Path.GetDirectoryName(oldDirectory)!;

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        Assert.Null(Index.GetDocument(_fixture.Cell.ToString(), _fixture.Plugin));

        var newDoc = Index.GetDocument(result.NewFormKey!, _fixture.Plugin);
        Assert.NotNull(newDoc);
        Assert.Contains(result.NewFormKey!, newDoc!.Body!, StringComparison.Ordinal);

        var newFile = _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);
        Assert.Equal(parent, Path.GetDirectoryName(Path.GetDirectoryName(newFile)));
    }

    // ---- AC3b: renumber an embedded child ----

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

        Assert.Null(Index.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.At(RecordRef.Head).GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
        Assert.NotNull(Index.GetDocument(result.NewFormKey!, _fixture.Plugin));
    }

    // ---- AC4: renumbering a record a container references ----

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

            using var sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            var plugin = new PluginKey(pluginName, origin);
            ((ISessionManager)sessions).LoadExplicit(
                gameDirectory, [new ExplicitPluginInput(pluginName, pluginPath, origin, true)], GameRelease.Fallout4);
            Track(sessions, origin);

            var file = Directory.EnumerateFiles(
                    Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName)), "RecordData.json", SearchOption.AllDirectories)
                .Single(f => File.ReadAllText(f).Contains("\"ReferencerRef\"", StringComparison.Ordinal));
            Assert.Contains(npc.FormKey.ToString(), File.ReadAllText(file), StringComparison.Ordinal);

            var result = new RecordEditService(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
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
    private static void Track(SessionManager sessions, string origin) =>
        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(sessions.Session!, origin, SourcePreset.Edits).GetAwaiter().GetResult();

    // ---- AC5: order preservation ----

    /// <summary>
    /// #459's own AC dropped this exact scenario ("delete/create a mid-list embedded child ... assert
    /// surviving GRUP order") because the capability didn't exist yet — this is that scenario, on a
    /// container-nested folder-split list (<c>Quest.DialogTopics</c>) rather than a flat top-level one.
    /// Renumber <i>is</i> "delete the old file, create the new one" for the same child (the ticket's
    /// own framing), so renumbering the middle of three DialogTopics exercises exactly "delete then
    /// create a mid-list embedded child" in one gesture.
    ///
    /// <para><b>#489 (filed alongside this ticket, now fixed):</b> this test originally asserted the
    /// untouched survivors kept their <i>original</i> slots (a permanent gap at the renumbered record's
    /// old slot) and could only be verified against the tracked source tree's own <c>"[N] "</c>-prefixed
    /// names directly, never by compiling — a gap-leaving delete or renumber, on any record type,
    /// container or not, made <see cref="PluginCompileService"/>'s round-trip gate (#473) refuse to
    /// compile, because that gate regenerates canonical names by contiguous in-memory list position and
    /// a gap is by design not contiguous. #489 retired the gap: every structural write renormalizes its
    /// own touched group folder to contiguous <c>[0..k]</c> as its own last file-system act. This test
    /// now asserts <i>both</i> halves of that — the tree's own renumbered slots directly (what the old
    /// assertion checked, updated to the new contiguous outcome) <i>and</i> that a compile of the result
    /// now succeeds and reproduces the survivors' relative order in the binary (what a successful
    /// compile does not, by itself, prove about the literal on-disk slot numbers).</para>
    /// </summary>
    [Fact]
    public void RenumberingAMidListFolderSplitChild_RenormalizesSurvivingSiblingsToContiguousSlots_AndCompiles()
    {
        var dialogTopicsDirectory = Path.GetDirectoryName(
            Path.GetDirectoryName(_fixture.SourceFileContaining(ContainerModFixture.DialogTopicEditorId)))!;
        Assert.Equal("DialogTopics", Path.GetFileName(dialogTopicsDirectory));

        var result = EditService().RenumberRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(result.Applied, result.Message);

        var slots = Directory.EnumerateDirectories(dialogTopicsDirectory)
            .Select(d => Path.GetFileName(d))
            .Select(name => (Index: SourceUnitResolver.TryGetOrderIndex(name)!.Value, Name: name))
            .OrderBy(s => s.Index)
            .ToList();

        Assert.Equal(3, slots.Count);
        // The two untouched survivors renormalize to contiguous slots, in their original relative
        // order — DialogTopic was already slot 0 (untouched); DialogTopic3 moves down from slot 2 to
        // slot 1, closing the gap the renumbered record's old slot left.
        Assert.Equal(0, slots[0].Index);
        Assert.Contains(ContainerModFixture.DialogTopicEditorId, slots[0].Name, StringComparison.Ordinal);
        Assert.Equal(1, slots[1].Index);
        Assert.Contains(ContainerModFixture.DialogTopic3EditorId, slots[1].Name, StringComparison.Ordinal);
        // ...and the renumbered record (same EditorID, new FormKey) appends at the next contiguous slot
        // (2), never left at a gapped slot further out.
        Assert.Equal(2, slots[2].Index);
        Assert.Contains(ContainerModFixture.DialogTopic2EditorId, slots[2].Name, StringComparison.Ordinal);
        Assert.Contains(result.NewFormKey!.Split(':')[0], slots[2].Name, StringComparison.OrdinalIgnoreCase);

        // #489's own promise: this now compiles (it refused before the fix), and the compiled binary's
        // DialogTopics preserve the survivors' relative order.
        var compileResult = new PluginCompileService(
                _fixture.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);

        var pluginPath = Path.Combine(_fixture.ModFolder, ContainerModFixture.PluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == _fixture.Quest);
        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic3EditorId, ContainerModFixture.DialogTopic2EditorId],
            quest.DialogTopics.Select(t => t.EditorID!).ToArray());
    }

    /// <summary>
    /// AC5's guard half: a plausible wrong generalization is reaching for
    /// <see cref="SourceUnitResolver.NextOrderIndexFor"/> — the existing top-level-only helper
    /// <see cref="RecordEditService.CreateRecord"/> already uses — instead of the lower-level
    /// <see cref="SourceUnitResolver.NextOrderIndex"/> over the child's <i>own</i> parent directory.
    /// <see cref="SourceUnitResolver.NextOrderIndexFor"/>'s null-forgiving
    /// <c>RecordTypeDispatch.FolderNameFor(recordType)!</c> is null for a DialogTopic (no top-level
    /// group of its own), which <c>Path.Combine</c> then rejects outright — demonstrated directly
    /// against that helper (observed: <c>ArgumentNullException</c>, "Value cannot be null.
    /// (Parameter 'path3')" — not the <c>NullReferenceException</c> the doc-comment reasoning alone
    /// would predict from a bare <c>!</c>, since the null actually reaches <c>Path.Combine</c> as an
    /// argument rather than being dereferenced) rather than by temporarily breaking
    /// <see cref="RecordEditService"/> itself.
    /// </summary>
    [Fact]
    public void RenumberOfANestedFolderSplitChild_ThrowsArgumentNull_IfItUsedTheTopLevelOnlyIndexHelper()
    {
        Assert.Throws<ArgumentNullException>(() =>
            SourceUnitResolver.NextOrderIndexFor(_fixture.ModFolder, ContainerModFixture.PluginName, "dial", GameRelease.Fallout4));
    }
}
