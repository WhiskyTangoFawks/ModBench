using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.Source;

/// <summary>
/// Interior cells are folder-split three levels deep — <c>Cells/&lt;block&gt;/&lt;sub-block&gt;/&lt;cell&gt;/</c>
/// — and every one of those levels is an ordered list whose order the parent's document must carry
/// (ADR-0042 decision 4). The top of that nesting is not an ordinary group: <c>Cells</c> is a
/// <i>list</i> group of blocks rather than a FormKey-keyed group of records, and a walk that only
/// recognises the record-keyed shape skips the whole subtree silently — Track writes no order for it,
/// the read honours none, and the compiled binary's cell order becomes whatever the filesystem
/// enumerated. Nothing refuses, because there is no list to disagree with. This suite is the one that
/// notices.
/// </summary>
public sealed class InteriorCellOrderTests : IDisposable
{
    private const string PluginName = "Interior.esp";
    private readonly string _folder = Directory.CreateTempSubdirectory("medit-interior-order-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    private string CellsFolder => Path.Combine(_folder, nameof(Fallout4Mod.Cells));

    /// <summary>Three cells in one sub-block, one more in a second block — enough that a reversal
    /// cannot coincide with the original at either level.</summary>
    private static (Fallout4Mod Mod, List<string> SubBlockCells) BuildMod()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        var cells = new List<string>();
        foreach (var name in new[] { "CellA", "CellB", "CellC" })
        {
            var cell = new Cell(mod) { EditorID = name };
            subBlock.Cells.Add(cell);
            cells.Add(cell.FormKey.ToString());
        }
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        var otherSub = new CellSubBlock { BlockNumber = 1, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        otherSub.Cells.Add(new Cell(mod) { EditorID = "CellD" });
        var otherBlock = new CellBlock { BlockNumber = 1, GroupType = GroupTypeEnum.InteriorCellBlock };
        otherBlock.SubBlocks.Add(otherSub);
        mod.Cells.Records.Add(otherBlock);
        return (mod, cells);
    }

    private async Task<List<string>> WriteTree()
    {
        var (mod, cells) = BuildMod();
        await RecordTextCodecGeneratorSeed.SerializeWholeMod(mod, _folder, InlineWorkDropoff.Instance, CancellationToken.None);
        SourceChildOrder.SpliceInto(_folder, mod);
        return cells;
    }

    [Fact]
    public async Task Track_CarriesTheOrderOfEveryInteriorCellLevel_InTheParentDocumentAboveIt()
    {
        var cells = await WriteTree();

        Assert.Equal(
            ["0", "1"],
            SourceChildOrder.ListAt(SourceChildOrder.CarrierFor(CellsFolder, parentIsRecord: false), nameof(Fallout4Mod.Cells)));
        Assert.Equal(
            ["0"],
            SourceChildOrder.ListAt(
                SourceChildOrder.CarrierFor(Path.Combine(CellsFolder, "0"), parentIsRecord: false), nameof(CellBlock.SubBlocks)));
        Assert.Equal(
            cells,
            SourceChildOrder.ListAt(
                SourceChildOrder.CarrierFor(Path.Combine(CellsFolder, "0", "0"), parentIsRecord: false), nameof(CellSubBlock.Cells)));
    }

    /// <summary>The read honours the sub-block's list rather than the filesystem: reverse the list,
    /// touch no file, and the cells come back reversed.</summary>
    [Fact]
    public async Task ReversingASubBlocksRecordedOrder_ReversesTheCellsItReadsBack()
    {
        var cells = await WriteTree();
        var carrier = SourceChildOrder.CarrierFor(Path.Combine(CellsFolder, "0", "0"), parentIsRecord: false);
        RewriteOrder(carrier, nameof(CellSubBlock.Cells), [.. Enumerable.Reverse(cells)]);

        var read = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(_folder, InlineWorkDropoff.Instance, CancellationToken.None);

        var block = read.Cells.Records.Single(b => b.BlockNumber == 0);
        Assert.Equal(
            Enumerable.Reverse(cells).ToList(),
            block.SubBlocks.Single().Cells.Select(c => c.FormKey.ToString()).ToList());
    }

    [Fact]
    public async Task ReversingTheBlockListsRecordedOrder_ReversesTheBlocksItReadsBack()
    {
        await WriteTree();
        var carrier = SourceChildOrder.CarrierFor(CellsFolder, parentIsRecord: false);
        RewriteOrder(carrier, nameof(Fallout4Mod.Cells), ["1", "0"]);

        var read = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(_folder, InlineWorkDropoff.Instance, CancellationToken.None);

        Assert.Equal([1, 0], read.Cells.Records.Select(b => b.BlockNumber).ToList());
    }

    private static void RewriteOrder(string carrierPath, string key, IReadOnlyList<string> order)
    {
        var document = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(carrierPath))!.AsObject();
        var list = new System.Text.Json.Nodes.JsonArray();
        foreach (var identity in order) list.Add(identity);
        document[SourceChildOrder.OrderMember]!.AsObject()[key] = list;
        File.WriteAllText(carrierPath, document.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
    }
}
