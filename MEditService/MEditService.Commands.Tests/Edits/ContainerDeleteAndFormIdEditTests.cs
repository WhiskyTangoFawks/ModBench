using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class ContainerDeleteAndFormIdEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private DeleteRecordHandler DeleteHandler() => _fixture.DeleteHandler;

    [Fact]
    public void DeletingAContainersOwnRecord_RemovesItsDirectory_AndEveryEmbeddedDescendantWithIt()
    {
        var embedCellFile = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var directory = Path.GetDirectoryName(embedCellFile)
            ?? throw new InvalidOperationException($"Expected '{embedCellFile}' to have a parent directory.");
        Assert.True(Directory.Exists(directory));

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.EmbedCell.ToString())]);

        Assert.Empty(result.Refused);
        Assert.False(Directory.Exists(directory));

        Assert.Null(_fixture.Document(_fixture.EmbedCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.Null(_fixture.Document(_fixture.PersistentRef.ToString()));
        Assert.Null(_fixture.Document(_fixture.Navmesh.ToString()));
        Assert.Null(_fixture.Document(_fixture.Landscape.ToString()));

        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.EmbedCell.ToString(), "cell", ContainerModPlugin.EmbedCellEditorId));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModPlugin.TemporaryRefEditorId));
    }

    [Fact]
    public void DeletingAWorldspace_CascadesTwoLevelsDeep_ThroughItsEmbeddedTopCellToTheTopCellsOwnRef()
    {
        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Worldspace.ToString())]);

        Assert.Empty(result.Refused);
        Assert.Null(_fixture.Document(_fixture.Worldspace.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCellRef.ToString()));
    }

    [Fact]
    public void DeletingAnEmbeddedListChild_RemovesItFromTheOwnersInlineList_AndRewritesTheOwnersDocument_LeavingSiblingsIntact()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        Assert.Contains(ContainerModPlugin.TemporaryRefEditorId, before, StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.TemporaryRef.ToString())]);

        Assert.Empty(result.Refused);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModPlugin.TemporaryRefEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.PersistentRefEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.LandscapeEditorId, after, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModPlugin.TemporaryRefEditorId));
        Assert.DoesNotContain(
            ContainerModPlugin.TemporaryRefEditorId,
            _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body,
            StringComparison.Ordinal);
    }

    [Fact]
    public void DeletingACellsLandscape_NullsTheSlot_LeavingItsNavmeshIntact()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Landscape.ToString())]);

        Assert.Empty(result.Refused);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModPlugin.LandscapeEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Null(_fixture.Document(_fixture.Landscape.ToString()));
        Assert.NotNull(_fixture.Document(_fixture.EmbedCell.ToString()));
    }

    [Fact]
    public void DeletingACellsNavmesh_RemovesItFromTheCellsList_LeavingItsLandscapeIntact()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Navmesh.ToString())]);

        Assert.Empty(result.Refused);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModPlugin.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.LandscapeEditorId, after, StringComparison.Ordinal);
        Assert.Null(_fixture.Document(_fixture.Navmesh.ToString()));
        Assert.NotNull(_fixture.Document(_fixture.EmbedCell.ToString()));
    }

    [Fact]
    public void DeletingASingleValueEmbeddedSlot_NullsTheSlot_AndCascadesItsOwnDescendant()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.WorldspaceEditorId);
        Assert.Contains(ContainerModPlugin.TopCellEditorId, File.ReadAllText(file), StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.TopCell.ToString())]);

        Assert.Empty(result.Refused);
        var after = File.ReadAllText(file);
        Assert.DoesNotContain(ContainerModPlugin.TopCellEditorId, after, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModPlugin.TopCellRefEditorId, after, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TopCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCellRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TopCell.ToString(), "cell", ContainerModPlugin.TopCellEditorId));
        Assert.NotNull(_fixture.Document(_fixture.Worldspace.ToString()));
    }

    [Fact]
    public void EditingTheFormIdOfAContainersOwnRecord_MovesItsDirectoryToTheNewFormKey_AtTheSameParent()
    {
        var cellFile = _fixture.SourceFileContaining(ContainerModPlugin.CellEditorId);
        var oldDirectory = Path.GetDirectoryName(cellFile)
            ?? throw new InvalidOperationException($"Expected '{cellFile}' to have a parent directory.");
        var parent = Path.GetDirectoryName(oldDirectory) ?? throw new InvalidOperationException($"Expected '{oldDirectory}' to have a parent directory.");

        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Cell.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        Assert.False(Directory.Exists(oldDirectory));
        Assert.Null(_fixture.Document(_fixture.Cell.ToString()));

        var moved = _fixture.Document(result.NewFormKey.Require());
        Assert.NotNull(moved);
        Assert.Contains(result.NewFormKey.Require(), moved.Body, StringComparison.Ordinal);

        var newFile = _fixture.SourceFileContaining(ContainerModPlugin.CellEditorId);
        Assert.Equal(parent, Path.GetDirectoryName(Path.GetDirectoryName(newFile)));
    }

    [Fact]
    public void EditingTheFormIdOfAnEmbeddedChild_ChangesOnlyItsFormKeyInPlace_NoFileMoves_SameOwnerFile()
    {
        var file = _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId);
        var before = File.ReadAllText(file);
        var formKeyLine = $"\"FormKey\": \"{_fixture.TemporaryRef}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);

        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.TemporaryRef.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(file, _fixture.SourceFileContaining(ContainerModPlugin.EmbedCellEditorId));
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{result.NewFormKey.Require()}\"", StringComparison.Ordinal),
            File.ReadAllText(file));

        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModPlugin.TemporaryRefEditorId));
        Assert.NotNull(_fixture.Document(result.NewFormKey.Require()));
    }

    [Fact]
    public void EditingTheFormIdOfARecordReferencedByAContainer_LeavesTheContainersFileAsItWas()
    {
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
        var before = File.ReadAllText(file);
        Assert.Contains(referenced.ToString(), before, StringComparison.Ordinal);

        var result = referencer.EditHandler.SetFormId(referencer.Plugin, referenced.ToString(), $"000F00:{pluginName}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before, File.ReadAllText(file));
    }

    [Fact]
    public void EditingTheFormIdOfAnEmbeddedChild_LeavesASiblingThatLinksIt_AsItWas()
    {
        const string pluginName = "SiblingReferencer.esp";
        var enabler = FormKey.Null;
        using var mod = SourceModFixture.Tracked(pluginName, "SiblingReferencerMod", m =>
        {
            var cell = new Cell(m) { EditorID = "SiblingCell", WaterHeight = 0f };
            var first = new PlacedObject(m) { EditorID = "EnablerRef", Position = new Noggog.P3Float(0, 0, 0) };
            var second = new PlacedObject(m)
            {
                EditorID = "EnabledRef",
                Position = new Noggog.P3Float(1, 0, 0),
                EnableParent = new EnableParent { Reference = new FormLink<IPlacedGetter>(first.FormKey), Unknown = new byte[3] },
            };
            cell.Temporary.Add(first);
            cell.Temporary.Add(second);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            m.Cells.Records.Add(block);
            enabler = first.FormKey;
        });
        var file = Directory.EnumerateFiles(
                Path.Combine(mod.ModFolder, SourceRepository.RootFor(pluginName)), "RecordData.json",
                SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"EnablerRef\"", StringComparison.Ordinal));
        var before = File.ReadAllText(file);
        var formKeyLine = $"\"FormKey\": \"{enabler}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);
        Assert.Contains($"\"Reference\": \"{enabler}\"", before, StringComparison.Ordinal);

        var result = mod.EditHandler.SetFormId(mod.Plugin, enabler.ToString(), $"000F00:{pluginName}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{result.NewFormKey.Require()}\"", StringComparison.Ordinal),
            File.ReadAllText(file));
    }

    [Fact]
    public async Task DeletingEveryTopicOfAQuest_LeavesNoEmptyListBehind_AndCompiles()
    {
        var deletes = DeleteHandler();
        foreach (var topic in new[] { _fixture.DialogTopic, _fixture.DialogTopic2, _fixture.DialogTopic3 })
        {
            var deleted = deletes.DeleteRecords([new RecordAt(_fixture.Plugin, topic.ToString())]);
            Assert.Empty(deleted.Refused);
        }

        var questFile = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);
        Assert.DoesNotContain($"\"{nameof(Quest.DialogTopics)}\"", File.ReadAllText(questFile), StringComparison.Ordinal);

        var compileResult = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.Plugin);
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }
}
