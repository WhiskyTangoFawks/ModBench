using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class ContainerDeleteAndFormIdEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string EmbedCellText() => _fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId).Body;

    private string WorldspaceText() => _fixture.DocumentCarrying(ContainerModPlugin.WorldspaceEditorId).Body;

    private DeleteRecordHandler DeleteHandler() => _fixture.DeleteHandler;

    [Fact]
    public void DeletingAContainersOwnRecord_RemovesEveryEmbeddedDescendantWithIt()
    {
        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.EmbedCell.ToString())]);

        Assert.Empty(result.Refused);

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
        var before = EmbedCellText();
        Assert.Contains(ContainerModPlugin.TemporaryRefEditorId, before, StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.TemporaryRef.ToString())]);

        Assert.Empty(result.Refused);
        var after = EmbedCellText();
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
        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Landscape.ToString())]);

        Assert.Empty(result.Refused);
        var after = EmbedCellText();
        Assert.DoesNotContain(ContainerModPlugin.LandscapeEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Null(_fixture.Document(_fixture.Landscape.ToString()));
        Assert.NotNull(_fixture.Document(_fixture.EmbedCell.ToString()));
    }

    [Fact]
    public void DeletingACellsNavmesh_RemovesItFromTheCellsList_LeavingItsLandscapeIntact()
    {
        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.Navmesh.ToString())]);

        Assert.Empty(result.Refused);
        var after = EmbedCellText();
        Assert.DoesNotContain(ContainerModPlugin.NavmeshEditorId, after, StringComparison.Ordinal);
        Assert.Contains(ContainerModPlugin.LandscapeEditorId, after, StringComparison.Ordinal);
        Assert.Null(_fixture.Document(_fixture.Navmesh.ToString()));
        Assert.NotNull(_fixture.Document(_fixture.EmbedCell.ToString()));
    }

    [Fact]
    public void DeletingASingleValueEmbeddedSlot_NullsTheSlot_AndCascadesItsOwnDescendant()
    {
        Assert.Contains(ContainerModPlugin.TopCellEditorId, WorldspaceText(), StringComparison.Ordinal);

        var result = DeleteHandler().DeleteRecords([new RecordAt(_fixture.Plugin, _fixture.TopCell.ToString())]);

        Assert.Empty(result.Refused);
        var after = WorldspaceText();
        Assert.DoesNotContain(ContainerModPlugin.TopCellEditorId, after, StringComparison.Ordinal);
        Assert.DoesNotContain(ContainerModPlugin.TopCellRefEditorId, after, StringComparison.Ordinal);

        Assert.Null(_fixture.Document(_fixture.TopCell.ToString()));
        Assert.Null(_fixture.Document(_fixture.TopCellRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TopCell.ToString(), "cell", ContainerModPlugin.TopCellEditorId));
        Assert.NotNull(_fixture.Document(_fixture.Worldspace.ToString()));
    }

    [Fact]
    public void EditingTheFormIdOfAContainersOwnRecord_MovesItsDocumentToTheNewFormKey()
    {
        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.Cell.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        Assert.Null(_fixture.Document(_fixture.Cell.ToString()));

        var moved = _fixture.Document(result.NewFormKey.Require());
        Assert.NotNull(moved);
        Assert.Contains(result.NewFormKey.Require(), moved.Body, StringComparison.Ordinal);
        Assert.Equal(result.NewFormKey.Require(), _fixture.DocumentCarrying(ContainerModPlugin.CellEditorId).FormKey);
    }

    [Fact]
    public void EditingTheFormIdOfAnEmbeddedChild_ChangesOnlyItsFormKeyInPlace_InTheSameOwnerDocument()
    {
        var before = EmbedCellText();
        var formKeyLine = $"\"FormKey\": \"{_fixture.TemporaryRef}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);

        var result = _fixture.EditHandler.SetFormId(_fixture.Plugin, _fixture.TemporaryRef.ToString(), $"000F00:{_fixture.Plugin.Name}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(_fixture.EmbedCell.ToString(), _fixture.DocumentCarrying(ContainerModPlugin.EmbedCellEditorId).FormKey);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{result.NewFormKey.Require()}\"", StringComparison.Ordinal),
            EmbedCellText());

        Assert.Null(_fixture.Document(_fixture.TemporaryRef.ToString()));
        Assert.NotNull(_fixture.CommittedDocument(
            _fixture.TemporaryRef.ToString(), "refr", ContainerModPlugin.TemporaryRefEditorId));
        Assert.NotNull(_fixture.Document(result.NewFormKey.Require()));
    }

    [Fact]
    public void EditingTheFormIdOfARecordReferencedByAContainer_LeavesTheContainersDocumentAsItWas()
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

        var before = TrackedTree.DocumentCarrying(referencer.ModFolder, referencer.Plugin, "ReferencerRef").Body;
        Assert.Contains(referenced.ToString(), before, StringComparison.Ordinal);

        var result = referencer.EditHandler.SetFormId(referencer.Plugin, referenced.ToString(), $"000F00:{pluginName}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before, TrackedTree.DocumentCarrying(referencer.ModFolder, referencer.Plugin, "ReferencerRef").Body);
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
        var before = TrackedTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "EnablerRef").Body;
        var formKeyLine = $"\"FormKey\": \"{enabler}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);
        Assert.Contains($"\"Reference\": \"{enabler}\"", before, StringComparison.Ordinal);

        var result = mod.EditHandler.SetFormId(mod.Plugin, enabler.ToString(), $"000F00:{pluginName}");

        Assert.True(result.Applied, result.Message);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{result.NewFormKey.Require()}\"", StringComparison.Ordinal),
            TrackedTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "EnablerRef").Body);
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

        Assert.DoesNotContain($"\"{nameof(Quest.DialogTopics)}\"", _fixture.Document(_fixture.Quest.ToString()).Require().Body, StringComparison.Ordinal);

        var compileResult = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.Plugin);
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }
}
