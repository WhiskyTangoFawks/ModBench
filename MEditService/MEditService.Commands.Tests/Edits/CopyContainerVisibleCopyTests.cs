using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyContainerVisibleCopyTests : IDisposable
{
    private const float BaseWaterHeight = 5f;
    private const float PartialWaterHeight = 1f;
    private const float LaterWaterHeight = 9f;

    private static readonly FormKey BaseCell = new(ModKey.FromFileName("Base.esm"), 0x800);
    private static readonly FormKey BaseStatic = new(ModKey.FromFileName("Base.esm"), 0x801);
    private static readonly FormKey LaterStatic = new(ModKey.FromFileName("Later.esm"), 0x800);

    private readonly LoadOrderOfPlugins _plugins = new();
    private FormKey _ref;

    public void Dispose() => _plugins.Dispose();

    private static Cell CellOf(FormKey formKey, string editorId, float waterHeight, int flags = 0) =>
        new(formKey, Fallout4Release.Fallout4) { EditorID = editorId, WaterHeight = waterHeight, MajorRecordFlagsRaw = flags };

    private static void InAnInteriorBlock(Fallout4Mod mod, Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    private static Fallout4Mod HoldingTheCell(string name, string editorId, float waterHeight, int flags = 0) =>
        Plugin(name, mod => InAnInteriorBlock(mod, CellOf(BaseCell, editorId, waterHeight, flags)));

    private Fallout4Mod SourceWithARefInTheCell(string name, float waterHeight, int flags) => Plugin(name, mod =>
    {
        var cell = CellOf(BaseCell, "SourceCell", waterHeight, flags);
        var placed = new PlacedObject(mod) { EditorID = "CopiedRef", Position = new P3Float(1f, 2f, 3f), Scale = 1f };
        _ref = placed.FormKey;
        cell.Persistent.Add(placed);
        InAnInteriorBlock(mod, cell);
    });

    private static Fallout4Mod MasteringThrough(string name, FormKey held) =>
        Plugin(name, mod => mod.Statics.Add(new Static(held, Fallout4Release.Fallout4) { EditorID = name + "Static" }));

    private JsonObject DestinationCell(Fallout4Mod destination) =>
        JsonNode.Parse(_plugins.Text(destination, BaseCell)).Require().AsObject();

    private void CopyRefIntoDestination(Fallout4Mod source, Fallout4Mod destination)
    {
        var result = _plugins.CopyHandler.CopySync([new RecordAt(Address(source), _ref.ToString())], CopyMode.Override, [Address(destination)], replace: false);
        result.OnlyLanded();
    }

    [Fact]
    public void ACopiedInContainer_WhoseSourceCopyIsPartialForm_CarriesTheFieldsOfTheDestinationsMasterCopy()
    {
        var destination = MasteringThrough("Dest.esp", BaseStatic);
        var source = SourceWithARefInTheCell("Source.esp", PartialWaterHeight, PartialFormFlag.Bit);
        var master = Plugin("Base.esm", mod =>
        {
            InAnInteriorBlock(mod, CellOf(BaseCell, "BaseCell", BaseWaterHeight));
            mod.Statics.Add(new Static(BaseStatic, Fallout4Release.Fallout4) { EditorID = "BaseStatic" });
        });
        _plugins.Load((master, false), (source, false), (destination, true));

        CopyRefIntoDestination(source, destination);

        var cell = DestinationCell(destination);
        Assert.Equal("BaseCell", cell["EditorID"].Require().GetValue<string>());
        Assert.Equal(BaseWaterHeight, cell["WaterHeight"].Require().GetValue<float>());
        Assert.False(cell.ContainsKey("MajorRecordFlagsRaw"));
        Assert.Equal(_ref.ToString(), Assert.Single(cell["Persistent"].Require().AsArray()).Require()["FormKey"].Require().GetValue<string>());
    }

    [Fact]
    public void ACopiedInContainer_CarriesTheFieldsOfADestinationMasterThatLoadsAfterTheSourceAndOverridesIt()
    {
        var master = Plugin("Later.esm", mod =>
        {
            InAnInteriorBlock(mod, CellOf(BaseCell, "LaterCell", LaterWaterHeight));
            mod.Statics.Add(new Static(LaterStatic, Fallout4Release.Fallout4) { EditorID = "LaterStatic" });
        });
        var source = SourceWithARefInTheCell("Source.esm", BaseWaterHeight, 0);
        var destination = MasteringThrough("Dest.esp", LaterStatic);
        _plugins.Load((source, false), (master, false), (destination, true));

        CopyRefIntoDestination(source, destination);

        var cell = DestinationCell(destination);
        Assert.Equal("LaterCell", cell["EditorID"].Require().GetValue<string>());
        Assert.Equal(LaterWaterHeight, cell["WaterHeight"].Require().GetValue<float>());
    }

    [Fact]
    public void ACopiedInContainer_IntoADestinationWithNoLine_IsNotJudged_AndCarriesTheSourcesFields()
    {
        var master = Plugin("Later.esm", mod =>
        {
            InAnInteriorBlock(mod, CellOf(BaseCell, "LaterCell", LaterWaterHeight));
            mod.Statics.Add(new Static(LaterStatic, Fallout4Release.Fallout4) { EditorID = "LaterStatic" });
        });
        var source = SourceWithARefInTheCell("Source.esm", BaseWaterHeight, 0);
        var destination = MasteringThrough("Dest.esp", LaterStatic);
        _plugins.Load((source, false), (master, false), (destination, true));
        _plugins.Relist(Address(destination), entry => entry with { Slot = null });

        CopyRefIntoDestination(source, destination);

        Assert.Equal("SourceCell", DestinationCell(destination)["EditorID"].Require().GetValue<string>());
    }

    [Fact]
    public void ACopiedInContainer_IgnoresADestinationMasterThatLoadsBeforeTheSource()
    {
        var master = Plugin("Base.esm", mod =>
        {
            InAnInteriorBlock(mod, CellOf(BaseCell, "BaseCell", BaseWaterHeight));
            mod.Statics.Add(new Static(BaseStatic, Fallout4Release.Fallout4) { EditorID = "BaseStatic" });
        });
        var source = SourceWithARefInTheCell("Source.esp", PartialWaterHeight, 0);
        var destination = MasteringThrough("Dest.esp", BaseStatic);
        _plugins.Load((master, false), (source, false), (destination, true));

        CopyRefIntoDestination(source, destination);

        var cell = DestinationCell(destination);
        Assert.Equal("SourceCell", cell["EditorID"].Require().GetValue<string>());
        Assert.Equal(PartialWaterHeight, cell["WaterHeight"].Require().GetValue<float>());
    }
}
