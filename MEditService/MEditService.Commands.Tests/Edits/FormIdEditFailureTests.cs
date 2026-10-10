using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class FormIdEditFailureTests
{
    private static readonly FormKey NewNpcFormKey = FormKey.Factory("000F00:Fixture.esp");

    private static RecordIdentity NewNpcIdentity { get; } =
        new(NewNpcFormKey.ToString(), "npc_", SourceEditFixture.NpcEditorId);

    private const string NewWorldspaceFormKey = "000F00:SourceContainer.esp";

    [Fact]
    public void AFormIdEditWhoseContainerHasTwoSourceUnits_RefusesAsAmbiguousSourceUnit_NamingBothFiles_AndAnswersNoChanges()
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
        var before = TreeSnapshot.Of(mod.ModFolder);

        var result = mod.EditHandler.SetFormId(mod.Plugin, placed.ToString(), $"000F00:{pluginName}");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.AmbiguousSourceUnit, result.Refusal);
        Assert.Contains(Path.GetRelativePath(mod.ModFolder, cellFile), result.Message, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(mod.ModFolder, impostorFile), result.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
    }

    [Fact]
    public void AFormIdEditThatFaultsUnexpectedly_RethrowsTheFaultAsItself()
    {
        using var fixture = new SourceContainerFixture();
        var worldspace = fixture.DocumentCarrying(SourceContainerFixture.WorldspaceEditorId);
        fixture.Overwrite(worldspace with
        {
            Body = worldspace.Body.Replace(
                $"\"{SourceContainerFixture.WorldspaceEditorId}\"", "\"Fixture\\u0000World\"", StringComparison.Ordinal),
        });

        Assert.Throws<ArgumentException>(() =>
            fixture.EditHandler.SetFormId(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));
    }

    [Fact]
    public void AContainersFormIdEditOntoAnOccupiedPath_RefusesAsSourceAccessFailed_NamingThatThereIsNowhereToMoveTo()
    {
        using var fixture = new SourceContainerFixture();
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        var result = fixture.EditHandler.SetFormId(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey);

        Assert.Equal(RecordEditRefusal.SourceAccessFailed, result.Refusal);
        Assert.Contains("nowhere to move to", result.Message, StringComparison.Ordinal);
    }

    private static void Occupy(string directory)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "occupied.txt"), "something else is here");
    }

    private static string RelocatedWorldspaceDirectory(SourceContainerFixture fixture, string newFormKey)
    {
        ISourceRepository Repository() => TestAdapters.Source().OverFolder(TestMod.Of(fixture.Plugin, fixture.ModFolder), GameRelease.Fallout4);
        var identity = new RecordIdentity(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId);
        Repository().Put(fixture.Plugin, new SourceDocument(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId, "{}")).Wrote();
        var directory = TreeTampering.DirectoryOf(fixture.ModFolder, fixture.Plugin, identity);
        Repository().Remove(fixture.Plugin, identity).Wrote();
        return directory;
    }
}
