using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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
        _compiledPlugin = Add(compiledPlugin, "SourceMod");
    }

    [Fact]
    public void AWriteThatChangesATemplatedBit_ThroughItsMemberOrItsStruct_IsRefusedNamingTheBit()
    {
        var mod = new SkyrimMod(ModKey.FromFileName("Templated.esp"), SkyrimRelease.SkyrimSE);
        var template = mod.Npcs.AddNew("Template");
        var copy = mod.Npcs.AddNew("Copy");
        copy.Configuration.TemplateFlags = NpcConfiguration.TemplateFlag.BaseData;
        copy.Configuration.Flags = NpcConfiguration.Flag.Essential;
        copy.Template.SetTo(template.FormKey);
        var plugin = Add(mod, "TemplatedMod");
        var configuration = JsonNode.Parse(Document.Parse(RecordTextCodec.SerializeToText(copy, GameRelease.SkyrimSE)).DocumentAt("Configuration").Require().Text).Require();
        configuration["Flags"] = new JsonArray();

        var throughMember = EditHandler.Edit(plugin, copy.FormKey.ToString(), SetAt(Json("[]"), Member("Configuration"), Member("Flags")));
        var throughStruct = EditHandler.Edit(plugin, copy.FormKey.ToString(), SetAt(Json(configuration.ToJsonString()), Member("Configuration")));

        Assert.All([throughMember, throughStruct], result =>
        {
            Assert.Equal(RecordEditRefusal.TemplatedFieldReadOnly, result.Refusal);
            Assert.Contains("Configuration.Flags.Essential", result.Message);
        });
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
