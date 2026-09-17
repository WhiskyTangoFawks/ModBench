using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Delete and Renumber resolve containers through the repository's own Locate (internal), as
/// EditField does. A container moves or removes its directory whole; an embedded child is spliced
/// inside its owner's document, no file move.</summary>
public sealed class ContainerDeleteAndRenumberTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RenumberRecordHandler RenumberHandler() => _fixture.RenumberHandler;
    private DeleteRecordHandler DeleteHandler() => _fixture.DeleteHandler;

    // ---- a container's own record ----

    [Fact]
    public void DeletingAContainersOwnRecord_RemovesItsDirectory_AndEveryEmbeddedDescendantWithIt()
    {
        var directory = PathShape.DirectoryOf(_fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId));
        Assert.True(Directory.Exists(directory));

        var result = DeleteHandler().DeleteRecord(_fixture.Plugin, _fixture.EmbedCell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(directory));

        // The container itself, and every embedded child — all four of EmbedCell's slots.
        Assert.Null(_fixture.Document(_fixture.EmbedCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.Null(_fixture.Document(_fixture.PersistentRef.ToString()));
        Assert.Null(_fixture.Document(_fixture.Navmesh.ToString()));
        Assert.Null(_fixture.Document(_fixture.Landscape.ToString()));

        // Still at Head — this is a working-tree delete, not a hard erase.
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.EmbedCell.ToString(), "cell", ContainerModFixture.EmbedCellEditorId));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModFixture.TemporaryRefEditorId));
    }

    [Fact]
    public void DeletingAWorldspace_CascadesTwoLevelsDeep_ThroughItsEmbeddedTopCellToTheTopCellsOwnRef()
    {
        var result = DeleteHandler().DeleteRecord(_fixture.Plugin, _fixture.Worldspace.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Document(_fixture.Worldspace.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCellRef.ToString()));
    }

    // ---- an embedded child ----

    [Fact]
    public void DeletingAnEmbeddedListChild_RemovesItFromTheOwnersInlineList_AndRewritesTheOwnersDocument_LeavingSiblingsIntact()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        Assert.Contains(ContainerModFixture.TemporaryRefEditorId, before, StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModFixture.TemporaryRefEditorId, after, StringComparison.Ordinal);
        // Untouched siblings in the same document.
        Assert.Contains(ContainerModFixture.PersistentRefEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModFixture.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModFixture.LandscapeEditorId, after, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModFixture.TemporaryRefEditorId));
        // The owner's own document picked up the rewrite.
        Assert.DoesNotContain(
            ContainerModFixture.TemporaryRefEditorId,
            _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body,
            StringComparison.Ordinal);
    }

    // Worldspace.TopCell is the only single-value embedded slot this gesture can reach: SchemaReflector
    // publishes no schema for land or navm, so neither Cell slot has a document to read.
    [Fact]
    public void DeletingASingleValueEmbeddedSlot_NullsTheSlot_AndCascadesItsOwnDescendant()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId);
        Assert.Contains(ContainerModFixture.TopCellEditorId, File.ReadAllText(file), StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecord(_fixture.Plugin, _fixture.TopCell.ToString());

        Assert.True(result.Applied, result.Message);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModFixture.TopCellEditorId, after, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModFixture.TopCellRefEditorId, after, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TopCell.ToString()));
        // TopCellRef was itself embedded inside TopCell — cascaded, not orphaned.
        Assert.Null(_fixture.Document(_fixture.TopCellRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TopCell.ToString(), "cell", ContainerModFixture.TopCellEditorId));
        // The Worldspace itself is untouched — only its TopCell slot emptied.
        Assert.NotNull(_fixture.Document(_fixture.Worldspace.ToString()));
    }

    // ---- renumber a container's own record ----

    [Fact]
    public void RenumberingAContainersOwnRecord_MovesItsDirectoryToTheNewFormKey_AtTheSameParent()
    {
        var oldDirectory = PathShape.DirectoryOf(_fixture.SourceFileContaining(ContainerModFixture.CellEditorId));
        var parent = PathShape.DirectoryOf(oldDirectory);

        var result = RenumberHandler().RenumberRecord(_fixture.Plugin, _fixture.Cell.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        Assert.Null(_fixture.Document(_fixture.Cell.ToString()));

        var renumbered = _fixture.Document(result.NewFormKey.Require());
        Assert.NotNull(renumbered);
        Assert.Contains(result.NewFormKey.Require(), renumbered.Body, StringComparison.Ordinal);

        var newFile = _fixture.SourceFileContaining(ContainerModFixture.CellEditorId);
        Assert.Equal(parent, Path.GetDirectoryName(Path.GetDirectoryName(newFile)));
    }

    // ---- renumber an embedded child ----

    [Fact]
    public void RenumberingAnEmbeddedChild_ChangesItsFormKeyInPlace_NoFileMoves_SameOwnerFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var result = RenumberHandler().RenumberRecord(_fixture.Plugin, _fixture.TemporaryRef.ToString());

        Assert.True(result.Applied, result.Message);
        // Same file — an embedded record has no leaf of its own to move.
        Assert.Equal(file, _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId));
        var text = File.ReadAllText(file);
        Assert.Contains(result.NewFormKey.Require(), text, StringComparison.Ordinal);
        Assert.DoesNotContain(_fixture.TemporaryRef.ToString(), text, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModFixture.TemporaryRefEditorId));
        Assert.NotNull(_fixture.Document(result.NewFormKey.Require()));
    }

    // ---- renumbering a record a container references ----

    [Fact]
    public void RenumberingARecordReferencedByAContainer_RewritesTheContainersOwnFileCleanly()
    {
        // A self-contained mod rather than the shared fixture: none of ContainerModFixture's embedded refs
        // point anywhere, and giving one a real Base is a riskier change to a fixture four other suites
        // depend on than a small local one.
        const string pluginName = "ContainerReferencer.esp";
        var referenced = FormKey.Null;
        using var referencer = SourceModFixture.Tracked(pluginName, "ContainerReferencerMod", mod =>
        {
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
            referenced = npc.FormKey;
        });

        var file = Directory.EnumerateFiles(
                Path.Combine(referencer.ModFolder, SourceRepository.RootFor(pluginName)), "RecordData.json",
                SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"ReferencerRef\"", StringComparison.Ordinal));
        Assert.Contains(referenced.ToString(), File.ReadAllText(file), StringComparison.Ordinal);

        var result = referencer.RenumberHandler.RenumberRecord(referencer.Plugin, referenced.ToString());

        Assert.True(result.Applied, result.Message);
        var text = File.ReadAllText(file);
        Assert.DoesNotContain(referenced.ToString(), text, StringComparison.Ordinal);
        Assert.Contains(result.NewFormKey.Require(), text, StringComparison.Ordinal);
    }

    // ---- order preservation ----

    [Fact]
    public async Task DeletingEveryTopicOfAQuest_LeavesNoEmptyListBehind_AndCompiles()
    {
        var deletes = DeleteHandler();
        foreach (var topic in new[] { _fixture.DialogTopic, _fixture.DialogTopic2, _fixture.DialogTopic3 })
        {
            var deleted = deletes.DeleteRecord(_fixture.Plugin, topic.ToString());
            Assert.True(deleted.Applied, deleted.Message);
        }

        // The codec writes nothing for an emptied list, so the slot itself is gone from the document.
        var questFile = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);
        Assert.DoesNotContain($"\"{nameof(Quest.DialogTopics)}\"", File.ReadAllText(questFile), StringComparison.Ordinal);

        var compileResult = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }
}
