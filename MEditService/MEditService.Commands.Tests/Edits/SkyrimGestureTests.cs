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
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class SkyrimGestureTests : TestInstance
{
    private const string MasterName = "Master.esm";
    private const string CompiledPluginName = "CompiledPlugin.esp";

    private readonly FormKey _masterInteriorCell;
    private readonly FormKey _masterPlaced;
    private readonly FormKey _npc;
    private readonly PluginAddress _compiledPlugin;

    public SkyrimGestureTests()
        : base(GameRelease.SkyrimSE)
    {
        var master = new SkyrimMod(ModKey.FromFileName(MasterName), SkyrimRelease.SkyrimSE);
        var interior = new Cell(master) { EditorID = "MasterInterior", WaterHeight = 5f };
        var placed = new PlacedObject(master) { EditorID = "MasterPlaced", Placement = new Placement { Position = new P3Float(1, 2, 3) } };
        interior.Persistent.Add(placed);
        master.Cells.Records.Add(Interior(interior));
        (_masterInteriorCell, _masterPlaced) = (interior.FormKey, placed.FormKey);
        Add(master, "MasterMod", compiledPlugin: false);

        var compiledPlugin = new SkyrimMod(ModKey.FromFileName(CompiledPluginName), SkyrimRelease.SkyrimSE);
        _npc = compiledPlugin.Npcs.AddNew("CompiledPluginNpc").FormKey;
        _compiledPlugin = Add(compiledPlugin, "SourceMod");
    }

    private string CompiledPluginPath => Path.Combine(ModFolderOf(_compiledPlugin), CompiledPluginName);

    private ISkyrimModDisposableGetter Compiled() =>
        SkyrimMod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(CompiledPluginName), CompiledPluginPath), SkyrimRelease.SkyrimSE);

    [Fact]
    public async Task AFieldEdit_CompilesIntoTheSkyrimPlugin()
    {
        var result = EditHandler.Set(_compiledPlugin, _npc.ToString(), "Height", Json("1.25"));

        Assert.True(result.Applied, result.Message);
        await CompileHandler.CompileLandedAsync(_compiledPlugin);
        using var compiled = Compiled();
        Assert.Equal(1.25f, compiled.Npcs[_npc].Height);
    }

    [Fact]
    public void ANestedTemplatedMember_IsRefused_NamingItsFlag()
    {
        var mod = new SkyrimMod(ModKey.FromFileName("Templated.esp"), SkyrimRelease.SkyrimSE);
        var template = mod.Npcs.AddNew("Template");
        var copy = mod.Npcs.AddNew("Copy");
        copy.Configuration.TemplateFlags = NpcConfiguration.TemplateFlag.Stats;
        copy.Template.SetTo(template.FormKey);
        var plugin = Add(mod, "TemplatedMod");

        var result = EditHandler.Edit(plugin, copy.FormKey.ToString(), SetAt(Json("3"), Member("Configuration"), Member("SpeedMultiplier")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.TemplatedFieldReadOnly, result.Refusal);
        Assert.Contains("Configuration.SpeedMultiplier", result.Message);
        Assert.Contains("Stats", result.Message);
        Assert.True(EditHandler.Edit(plugin, copy.FormKey.ToString(), SetAt(Json("3"), Member("Configuration"), Member("DispositionBase"))).Applied);
    }

    [Fact]
    public void ClearingTheLastTemplateFlag_ThroughTheFlagsWrite_MakesTheMembersEditableAtOnce()
    {
        var mod = new SkyrimMod(ModKey.FromFileName("Templated.esp"), SkyrimRelease.SkyrimSE);
        var template = mod.Npcs.AddNew("Template");
        var copy = mod.Npcs.AddNew("Copy");
        copy.Configuration.TemplateFlags = NpcConfiguration.TemplateFlag.Stats;
        copy.Template.SetTo(template.FormKey);
        var plugin = Add(mod, "TemplatedMod");
        var level = SetAt(Json("3"), Member("Configuration"), Member("SpeedMultiplier"));

        Assert.False(EditHandler.Edit(plugin, copy.FormKey.ToString(), level).Applied);
        var cleared = EditHandler.Edit(plugin, copy.FormKey.ToString(), SetAt(Json("[]"), Member("Configuration"), Member("TemplateFlags")));

        Assert.True(cleared.Applied, cleared.Message);
        Assert.True(EditHandler.Edit(plugin, copy.FormKey.ToString(), level).Applied);
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightSkyrimPlugin()
    {
        var header = new FormKey(ModKey.FromFileName(CompiledPluginName), 0).ToString();

        var result = EditHandler.Set(_compiledPlugin, header, "IsSmallMaster", Json("true"));

        Assert.True(result.Applied, result.Message);
        await CompileHandler.CompileLandedAsync(_compiledPlugin);
        using var compiled = Compiled();
        Assert.True(compiled.IsSmallMaster);
    }

    [Fact]
    public void AnInteriorCellOfAMasterOtherThanSkyrimEsm_CopiedInAroundAChild_IsAPartialForm()
    {
        CopyHandler.CopySync(
            [new RecordAt(new PluginAddress(MasterName, "MasterMod"), _masterPlaced.ToString())], CopyMode.Override, [_compiledPlugin], replace: false)
            .OnlyLanded();

        var copied = JsonNode.Parse(SourceModTree.Body(ModFolderOf(_compiledPlugin), _compiledPlugin, _masterInteriorCell.ToString())).Require();
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
