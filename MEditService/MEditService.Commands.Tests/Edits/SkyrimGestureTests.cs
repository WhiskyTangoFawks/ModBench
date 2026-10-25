using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Skyrim;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class SkyrimGestureTests : IDisposable
{
    private const string MasterName = "Master.esm";
    private const string CompiledPluginName = "CompiledPlugin.esp";

    private readonly GameInstance _instance = new(GameRelease.SkyrimSE);
    private readonly FormKey _masterInteriorCell;
    private readonly FormKey _masterPlaced;
    private readonly FormKey _npc;
    private readonly PluginAddress _compiledPlugin;

    public SkyrimGestureTests()
    {
        var master = new SkyrimMod(ModKey.FromFileName(MasterName), SkyrimRelease.SkyrimSE);
        var interior = new Cell(master) { EditorID = "MasterInterior", WaterHeight = 5f };
        var placed = new PlacedObject(master) { EditorID = "MasterPlaced", Placement = new Placement { Position = new P3Float(1, 2, 3) } };
        interior.Persistent.Add(placed);
        master.Cells.Records.Add(Interior(interior));
        (_masterInteriorCell, _masterPlaced) = (interior.FormKey, placed.FormKey);
        _instance.AddPlugin(master, "MasterMod", compiledPlugin: false);

        var compiledPlugin = new SkyrimMod(ModKey.FromFileName(CompiledPluginName), SkyrimRelease.SkyrimSE);
        _npc = compiledPlugin.Npcs.AddNew("CompiledPluginNpc").FormKey;
        _compiledPlugin = _instance.AddPlugin(compiledPlugin, "SourceMod", compiledPlugin: true);
    }

    public void Dispose() => _instance.Dispose();

    private string CompiledPluginPath => Path.Combine(_instance.ModFolderOf(_compiledPlugin), CompiledPluginName);

    private ISkyrimModDisposableGetter Compiled() =>
        SkyrimMod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(CompiledPluginName), CompiledPluginPath), SkyrimRelease.SkyrimSE);

    [Fact]
    public async Task AFieldEdit_CompilesIntoTheSkyrimPlugin()
    {
        var result = _instance.EditHandler.Set(_compiledPlugin, _npc.ToString(), "Height", JsonDocument.Parse("1.25").RootElement);

        Assert.True(result.Applied, result.Message);
        await _instance.CompileHandler.CompileLandedAsync(_compiledPlugin);
        using var compiled = Compiled();
        Assert.Equal(1.25f, compiled.Npcs[_npc].Height);
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightSkyrimPlugin()
    {
        var header = new FormKey(ModKey.FromFileName(CompiledPluginName), 0).ToString();

        var result = _instance.EditHandler.Set(_compiledPlugin, header, "IsSmallMaster", JsonDocument.Parse("true").RootElement);

        Assert.True(result.Applied, result.Message);
        await _instance.CompileHandler.CompileLandedAsync(_compiledPlugin);
        using var compiled = Compiled();
        Assert.True(compiled.IsSmallMaster);
    }

    [Fact]
    public void AnInteriorCellOfAMasterOtherThanSkyrimEsm_CopiedInAroundAChild_IsAPartialForm()
    {
        _instance.CopyHandler.CopySync(
            [new RecordAt(new PluginAddress(MasterName, "MasterMod"), _masterPlaced.ToString())], CopyMode.Override, [_compiledPlugin], replace: false)
            .OnlyLanded();

        var copied = JsonNode.Parse(SourceModTree.Body(_instance.ModFolderOf(_compiledPlugin), _compiledPlugin, _masterInteriorCell.ToString())).Require();
        Assert.NotEqual(0, copied["MajorRecordFlagsRaw"].Require().GetValue<int>() & PartialFormFlag.Bit);
        Assert.Null(copied["WaterHeight"]);
    }

    private static CellBlock Interior(Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        return block;
    }
}
