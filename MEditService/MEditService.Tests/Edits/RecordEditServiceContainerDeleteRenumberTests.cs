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

/// <summary>Delete and Renumber resolve containers through <see cref="SourceUnitResolver"/>, as
/// EditField does. A container's own record moves or removes its directory whole; an embedded
/// child is spliced or renumbered inside its owner's document, no file move.</summary>
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

    // Overrides At to hand out a DelegatingReads intercepting one member; IRecordIndex itself declares
    // no reads to override.
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

    // Worldspace.TopCell is the only single-value embedded slot this gesture can reach: SchemaReflector
    // publishes no schema for land or navm, so GetDocument answers null for the Cell slots.
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
        // A self-contained mod rather than the shared fixture: none of ContainerModFixture's embedded refs
        // point anywhere, and giving one a real Base is a riskier change to a fixture four other suites
        // depend on than a small local one.
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

    [Fact]
    public void DeletingEveryTopicOfAQuest_LeavesNoEmptyListBehind_AndCompiles()
    {
        var service = EditService();
        foreach (var topic in new[] { _fixture.DialogTopic, _fixture.DialogTopic2, _fixture.DialogTopic3 })
        {
            var deleted = service.DeleteRecord(_fixture.Plugin, topic.ToString());
            Assert.True(deleted.Applied, deleted.Message);
        }

        var questFile = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);
        Assert.DoesNotContain(SourceChildOrder.OrderMember, File.ReadAllText(questFile), StringComparison.Ordinal);

        var compileResult = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }

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
        // Every sibling stays where it was, and the renumbered record holds its own middle slot under its
        // new FormKey rather than being appended past its siblings.
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
