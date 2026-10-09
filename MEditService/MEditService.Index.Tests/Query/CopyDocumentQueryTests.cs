using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class CopyDocumentQueryTests : IDisposable
{
    private const string Npc = "000800:Filed.esp";
    private const string PlacedRef = "000901:Filed.esp";
    private static readonly PluginAddress Plugin = new("Filed.esp", "FiledMod");

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("copy-document-query")
        .WithPlugin(Plugin.Name, mod =>
        {
            mod.Npcs.AddNew("FiledNpc");
            mod.ModHeader.Stats.NextFormID = 0x900;
            var cell = new Cell(mod) { EditorID = "FiledCell" };
            cell.Temporary.Add(new PlacedObject(mod) { EditorID = "FiledRef" });
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            mod.Cells.Records.Add(block);
        }, origin: Plugin.Origin)
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Entry => _fixture.Plugins.Single();

    private string NpcFile =>
        Path.Combine(PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), "Npcs", "FiledNpc - 000800_Filed.esp.json");

    private string CellFile => Directory.EnumerateFiles(
        PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), "FiledCell - *.json", SearchOption.AllDirectories).Single();

    private OpenedIndex Reconciled() => Indexes.Reconciled(_fixture);

    [Fact]
    public void ATrackedCopy_IsItsFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Reconciled();

        Assert.Equal(new CopyDocument(CopyDocumentKind.OwnFile, NpcFile), index.Records.GetCopyDocument(Plugin, Npc).Value());
    }

    [Fact]
    public void ATrackedChildCopy_IsInItsContainersFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Reconciled();

        Assert.Equal(new CopyDocument(CopyDocumentKind.ContainersFile, CellFile), index.Records.GetCopyDocument(Plugin, PlacedRef).Value());
    }

    [Fact]
    public void ATrackedCopyInAPluginThatIsNotActive_IsItsFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Indexes.Reconciled(_fixture.GameDirectory, [Entry with { Enabled = false }]);

        Assert.Equal(new CopyDocument(CopyDocumentKind.OwnFile, NpcFile), index.Records.GetCopyDocument(Plugin, Npc).Value());
    }

    [Fact]
    public void ATrackedCopyWhoseFileIsGone_HasNoAnswer()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Reconciled();

        File.Delete(NpcFile);

        Assert.Null(index.Records.GetCopyDocument(Plugin, Npc).Value());
    }

    [Fact]
    public void AnUntrackedCopy_IsRenderedUnderTheLayoutsName()
    {
        using var index = Reconciled();

        Assert.Equal(new CopyDocument(CopyDocumentKind.Rendered, "FiledNpc - 000800_Filed.esp.json"), index.Records.GetCopyDocument(Plugin, Npc).Value());
    }

    [Fact]
    public void ACopyInATrackedModWithNoSourceForItsPlugin_IsRenderedUnderTheLayoutsName()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        Directory.Delete(PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), recursive: true);
        using var index = Reconciled();

        Assert.Equal(new CopyDocument(CopyDocumentKind.Rendered, "FiledNpc - 000800_Filed.esp.json"), index.Records.GetCopyDocument(Plugin, Npc).Value());
    }

    [Fact]
    public void ACopyThePluginDoesNotHold_HasNoAnswer()
    {
        using var index = Reconciled();

        Assert.Null(index.Records.GetCopyDocument(Plugin with { Origin = "AnotherMod" }, Npc).Value());
    }
}
