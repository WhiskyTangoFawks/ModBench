using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class RenderedDocumentQueryTests : IDisposable
{
    private const string Npc = "000800:Shared.esp";
    private const string OnlyInModA = "000801:Shared.esp";
    private const string PlacedRef = "000901:Shared.esp";
    private static readonly PluginAddress ModA = new("Shared.esp", "ModA");
    private static readonly PluginAddress ModB = new("Shared.esp", "ModB");

    private readonly ScatteredFixtureData _twoPluginsOfOneName;
    private readonly OpenedIndex _index;

    public RenderedDocumentQueryTests()
    {
        _twoPluginsOfOneName = new PluginFixtureBuilder("rendered-document")
            .WithPlugin(ModA.Name, mod =>
            {
                mod.Npcs.AddNew("SharedNpc").Name = "held by ModA";
                mod.Npcs.AddNew("OnlyInModA");
            }, origin: ModA.Origin)
            .WithPlugin(ModB.Name, mod =>
            {
                mod.Npcs.AddNew("SharedNpc").Name = "held by ModB";
                mod.ModHeader.Stats.NextFormID = 0x900;
                var cell = new Cell(mod) { EditorID = "SharedCell" };
                cell.Temporary.Add(new PlacedObject(mod) { EditorID = "SharedRef" });
                var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
                subBlock.Cells.Add(cell);
                var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: ModB.Origin)
            .BuildScattered();
        _index = Indexes.Reconciled(_twoPluginsOfOneName);
    }

    public void Dispose()
    {
        _index.Dispose();
        _twoPluginsOfOneName.Dispose();
    }

    [Fact]
    public void APlacedReference_IsNamedByItsOwnEditorId()
    {
        Assert.Equal("SharedRef - 000901_Shared.esp.json", _index.Queries.GetRenderedDocument(ModB, PlacedRef).Value()?.FileName);
    }

    [Fact]
    public void ACopy_RendersAsTheDocumentItsPluginHolds_NotAnotherOfTheSameName()
    {
        var text = _index.Queries.GetRenderedDocument(ModB, Npc).Value()?.Text;

        Assert.Contains("held by ModB", text, StringComparison.Ordinal);
        Assert.DoesNotContain("held by ModA", text, StringComparison.Ordinal);
        Assert.Contains("held by ModA", _index.Queries.GetRenderedDocument(ModA, Npc).Value()?.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ACopyThePluginDoesNotHold_HasNoRendering()
    {
        Assert.Null(_index.Queries.GetRenderedDocument(ModB, OnlyInModA).Value());
    }

    [Fact]
    public void ACopyMEditCouldNotParse_RendersWhatCouldBeStored()
    {
        const string unreadable = "000800:DeletedNpc.esp";
        using var gameDirectory = new ScratchDirectory("medit-rendered-unreadable-");
        var path = Path.Combine(gameDirectory, "DeletedNpc.esp");
        DeletedNpcPlugin.WriteHoldingFields(path, FormKey.Factory(unreadable));
        var plugin = new PluginAddress("DeletedNpc.esp", PluginOrigin.DataDirectory);
        using var index = Indexes.Reconciled(
            gameDirectory, [new LoadOrderEntry(plugin.Name, path, plugin.Origin, Line: 0, Enabled: true, Winning: true)]);
        Assert.NotNull(index.RowOf(unreadable, plugin)?.ParseDiagnosis);

        var text = index.Queries.GetRenderedDocument(plugin, unreadable).Value()?.Text;

        Assert.Contains(unreadable, text, StringComparison.Ordinal);
        Assert.Contains("\"Guy\"", text, StringComparison.Ordinal);
    }
}
