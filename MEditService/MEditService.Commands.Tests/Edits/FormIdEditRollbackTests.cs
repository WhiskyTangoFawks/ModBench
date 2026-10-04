using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class FormIdEditRollbackTests
{
    private static readonly FormKey NewNpcFormKey = FormKey.Factory("000F00:Fixture.esp");

    private static RecordIdentity NewNpcIdentity { get; } =
        new(NewNpcFormKey.ToString(), "npc_", SourceEditFixture.NpcEditorId);

    private const string NewWorldspaceFormKey = "000F00:SourceContainer.esp";

    [Fact]
    public void BlockingTheRecordsNewFile_LeavesTheSourceTreeUnchanged()
    {
        using var mod = SourceEditFixture.Tracked();
        TreeTampering.BlockWrite(mod.ModFolder, mod.Plugin, NewNpcIdentity);

        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);
        var statusBefore = mod.ChangedFormKeys();

        var thrown = Assert.Throws<IOException>(() =>
            mod.EditHandler.SetFormId(mod.Plugin, mod.Npc.ToString(), NewNpcFormKey.ToString()));

        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
        Assert.Equal(statusBefore, mod.ChangedFormKeys());
        Assert.Contains("back as it was — nothing to review or revert", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFormIdEditWhoseContainerHasTwoSourceUnits_RefusesAsAmbiguous_WithTheTreeAsItWas()
    {
        const string pluginName = "TwoUnits.esp";
        var placed = FormKey.Null;
        using var mod = SourceModFixture.Tracked(pluginName, "TwoUnitsMod", m =>
        {
            var cell = new Cell(m) { EditorID = "TwoUnitsCell", WaterHeight = 0f };
            var placedRef = new PlacedObject(m) { EditorID = "TwoUnitsRef", Position = new Noggog.P3Float(0, 0, 0) };
            cell.Temporary.Add(placedRef);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            m.Cells.Records.Add(block);
            placed = placedRef.FormKey;
        });
        var cell = TrackedTree.DocumentCarrying(mod.ModFolder, mod.Plugin, "TwoUnitsRef");
        var cellIdentity = new RecordIdentity(cell.FormKey, cell.RecordType, cell.EditorId);
        var cellFile = TreeTampering.FileOf(mod.ModFolder, mod.Plugin, cellIdentity);
        var impostorFile = TreeTampering.DuplicateInSiblingDirectory(mod.ModFolder, mod.Plugin, cellIdentity);
        var before = TrackedTree.Records(mod.ModFolder, mod.Plugin);

        var result = mod.EditHandler.SetFormId(mod.Plugin, placed.ToString(), $"000F00:{pluginName}");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, result.Refusal);
        Assert.Contains(Path.GetRelativePath(mod.ModFolder, cellFile), result.Message, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(mod.ModFolder, impostorFile), result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(mod.ModFolder, mod.Plugin));
    }

    [Fact]
    public void AFormIdEditThatFaultsUnexpectedly_RollsBack_AndRethrowsTheFaultAsItself()
    {
        using var fixture = new SourceContainerFixture();
        var worldspace = fixture.DocumentCarrying(SourceContainerFixture.WorldspaceEditorId);
        fixture.Overwrite(worldspace with
        {
            Body = worldspace.Body.Replace(
                $"\"{SourceContainerFixture.WorldspaceEditorId}\"", "\"Fixture\\u0000World\"", StringComparison.Ordinal),
        });
        var before = TrackedTree.Records(fixture.ModFolder, fixture.Plugin);

        Assert.Throws<ArgumentException>(() =>
            fixture.EditHandler.SetFormId(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));

        Assert.Equal(before, TrackedTree.Records(fixture.ModFolder, fixture.Plugin));
    }

    [Fact]
    public void AContainersFormIdEditOntoAnOccupiedPath_RefusesWithoutTouchingTheTree()
    {
        using var fixture = new SourceContainerFixture();
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        var before = TrackedTree.Records(fixture.ModFolder, fixture.Plugin);
        var statusBefore = fixture.ChangedFormKeys();

        var thrown = Assert.Throws<IOException>(() =>
            fixture.EditHandler.SetFormId(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));

        Assert.Contains("nowhere to move to", thrown.Message, StringComparison.Ordinal);
        Assert.Equal(before, TrackedTree.Records(fixture.ModFolder, fixture.Plugin));
        Assert.Equal(statusBefore, fixture.ChangedFormKeys());
    }

    private static void Occupy(string directory)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "occupied.txt"), "something else is here");
    }

    private static string RelocatedWorldspaceDirectory(SourceContainerFixture fixture, string newFormKey)
    {
        var repository = SourceRepository.Over(fixture.ModFolder, GameRelease.Fallout4);
        var identity = new RecordIdentity(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId);
        repository.Put(fixture.Plugin, new SourceDocument(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId, "{}"));
        var directory = TreeTampering.DirectoryOf(fixture.ModFolder, fixture.Plugin, identity);
        repository.Remove(fixture.Plugin, identity);
        return directory;
    }
}
