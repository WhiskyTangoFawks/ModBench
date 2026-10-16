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
    private const string SourcePluginName = "SourcePlugin.esp";

    private readonly SkyrimInstance _instance = new();
    private readonly FormKey _masterInteriorCell;
    private readonly FormKey _masterPlaced;
    private readonly FormKey _npc;
    private readonly PluginAddress _sourcePlugin;

    public SkyrimGestureTests()
    {
        var master = new SkyrimMod(ModKey.FromFileName(MasterName), SkyrimRelease.SkyrimSE);
        var interior = new Cell(master) { EditorID = "MasterInterior", WaterHeight = 5f };
        var placed = new PlacedObject(master) { EditorID = "MasterPlaced", Placement = new Placement { Position = new P3Float(1, 2, 3) } };
        interior.Persistent.Add(placed);
        master.Cells.Records.Add(Interior(interior));
        (_masterInteriorCell, _masterPlaced) = (interior.FormKey, placed.FormKey);
        _instance.AddPlugin(master, "MasterMod", sourcePlugin: false);

        var sourcePlugin = new SkyrimMod(ModKey.FromFileName(SourcePluginName), SkyrimRelease.SkyrimSE);
        _npc = sourcePlugin.Npcs.AddNew("SourcePluginNpc").FormKey;
        _sourcePlugin = _instance.AddPlugin(sourcePlugin, "SourceMod", sourcePlugin: true);
    }

    public void Dispose() => _instance.Dispose();

    private string SourcePluginPath => Path.Combine(_instance.ModFolderOf(_sourcePlugin), SourcePluginName);

    private ISkyrimModDisposableGetter Compiled() =>
        SkyrimMod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(SourcePluginName), SourcePluginPath), SkyrimRelease.SkyrimSE);

    [Fact]
    public async Task AFieldEdit_CompilesIntoTheSkyrimPlugin()
    {
        var result = _instance.EditHandler.Set(_sourcePlugin, _npc.ToString(), "Height", JsonDocument.Parse("1.25").RootElement);

        Assert.True(result.Applied, result.Message);
        await _instance.CompileHandler.CompileLandedAsync(_sourcePlugin);
        using var compiled = Compiled();
        Assert.Equal(1.25f, compiled.Npcs[_npc].Height);
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightSkyrimPlugin()
    {
        var header = new FormKey(ModKey.FromFileName(SourcePluginName), 0).ToString();

        var result = _instance.EditHandler.Set(_sourcePlugin, header, "IsSmallMaster", JsonDocument.Parse("true").RootElement);

        Assert.True(result.Applied, result.Message);
        await _instance.CompileHandler.CompileLandedAsync(_sourcePlugin);
        using var compiled = Compiled();
        Assert.True(compiled.IsSmallMaster);
    }

    [Fact]
    public void AnInteriorCellOfAMasterOtherThanSkyrimEsm_CopiedInAroundAChild_IsAPartialForm()
    {
        _instance.CopyHandler.CopySync(
            [new RecordAt(new PluginAddress(MasterName, "MasterMod"), _masterPlaced.ToString())], CopyMode.Override, [_sourcePlugin], replace: false)
            .OnlyLanded();

        var copied = JsonNode.Parse(SourceModTree.Body(_instance.ModFolderOf(_sourcePlugin), _sourcePlugin, _masterInteriorCell.ToString())).Require();
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

    private sealed class SkyrimInstance() : TestInstance(GameRelease.SkyrimSE)
    {
        public PluginAddress AddPlugin(SkyrimMod mod, string origin, bool sourcePlugin) => Add(mod, origin, sourcePlugin);
    }
}
