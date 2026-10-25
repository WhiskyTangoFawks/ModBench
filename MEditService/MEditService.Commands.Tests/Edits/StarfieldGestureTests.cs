using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class StarfieldGestureTests : TestInstance
{
    private const string LightName = "Light.esm";
    private const string MediumName = "Medium.esm";
    private const string UnrelatedName = "Unrelated.esm";
    private const string CompiledPluginName = "CompiledPlugin.esp";

    private readonly FormKey _weapon;
    private readonly FormKey _lightInterior;
    private readonly FormKey _lightPlaced;
    private readonly FormKey _mediumKeyword;
    private readonly FormKey _world;
    private readonly FormKey _here;
    private readonly FormKey _wanderer;
    private readonly PluginAddress _light;
    private readonly PluginAddress _unrelated;
    private readonly PluginAddress _compiledPlugin;

    public StarfieldGestureTests()
        : base(GameRelease.Starfield)
    {
        var light = new StarfieldMod(ModKey.FromFileName(LightName), StarfieldRelease.Starfield);
        light.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        _weapon = light.Weapons.AddNew("LightWeapon").FormKey;
        var interior = new Cell(light) { EditorID = "LightInterior", Flags = Cell.Flag.IsInteriorCell, WaterHeight = 5f };
        var placed = new PlacedObject(light) { EditorID = "LightPlaced", Position = new P3Float(1, 2, 3) };
        interior.Temporary.Add(placed);
        light.Cells.Records.Add(Interior(interior));
        (_lightInterior, _lightPlaced) = (interior.FormKey, placed.FormKey);
        _light = Add(light, "LightMod", compiledPlugin: false);

        var medium = new StarfieldMod(ModKey.FromFileName(MediumName), StarfieldRelease.Starfield);
        medium.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Medium;
        _mediumKeyword = medium.Keywords.AddNew("MediumKeyword").FormKey;
        Add(medium, "MediumMod", compiledPlugin: false);

        _unrelated = Add(new StarfieldMod(ModKey.FromFileName(UnrelatedName), StarfieldRelease.Starfield), "UnrelatedMod", compiledPlugin: false);

        var compiledPlugin = new StarfieldMod(ModKey.FromFileName(CompiledPluginName), StarfieldRelease.Starfield);
        var weapon = new Weapon(_weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride", Keywords = [] };
        weapon.Keywords.Add(_mediumKeyword);
        compiledPlugin.Weapons.Add(weapon);
        var world = new Worldspace(compiledPlugin) { EditorID = "World" };
        var here = new Cell(compiledPlugin) { EditorID = "Here", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var wanderer = new PlacedObject(compiledPlugin) { EditorID = "Wanderer", MajorRecordFlagsRaw = Persistent, Position = new P3Float(350, 350, 0) };
        here.Persistent.Add(wanderer);
        world.SubCells.Add(new WorldspaceBlock { Items = [new WorldspaceSubBlock { Items = [here] }] });
        compiledPlugin.Worldspaces.Add(world);
        (_world, _here, _wanderer) = (world.FormKey, here.FormKey, wanderer.FormKey);
        compiledPlugin.ModHeader.MasterReferences.AddRange([new MasterReference { Master = light.ModKey }, new MasterReference { Master = medium.ModKey }]);
        _compiledPlugin = Add(compiledPlugin, "SourceMod");
    }

    private const int Persistent = 0x400;

    private static string Header => new FormKey(ModKey.FromFileName(CompiledPluginName), 0).ToString();

    private IStarfieldModDisposableGetter Compiled() =>
        StarfieldMod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(CompiledPluginName), Path.Combine(ModFolderOf(_compiledPlugin), CompiledPluginName)), StarfieldRelease.Starfield,
            new BinaryReadParameters { MasterFlagsLookup = Added });

    private async Task<IStarfieldModDisposableGetter> CompiledAfterAsync()
    {
        await CompileHandler.CompileLandedAsync(_compiledPlugin);
        return Compiled();
    }

    [Fact]
    public async Task AFieldEdit_OnAnOverrideOfALightMastersRecord_CompilesIntoTheStarfieldPlugin()
    {
        var result = EditHandler.Set(_compiledPlugin, _weapon.ToString(), "EditorID", JsonDocument.Parse("\"Edited\"").RootElement);

        Assert.True(result.Applied, result.Message);
        using var compiled = await CompiledAfterAsync();
        var weapon = compiled.Weapons[_weapon];
        Assert.Equal("Edited", weapon.EditorID);
        Assert.Equal([_mediumKeyword], weapon.Keywords.Require().Select(keyword => keyword.FormKey));
    }

    [Fact]
    public async Task ACompile_WhoseLoadOrderHoldsAnUnrelatedPluginWhoseHeaderDoesNotRead_Lands()
    {
        File.WriteAllBytes(Path.Combine(ModFolderOf(_unrelated), UnrelatedName), "not a plugin"u8.ToArray());

        using var compiled = await CompiledAfterAsync();

        Assert.Equal("LightWeaponOverride", compiled.Weapons[_weapon].EditorID);
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightStarfieldPlugin()
    {
        var result = EditHandler.Set(_compiledPlugin, Header, "IsSmallMaster", JsonDocument.Parse("true").RootElement);

        Assert.True(result.Applied, result.Message);
        using var compiled = await CompiledAfterAsync();
        Assert.True(compiled.ModHeader.Flags.HasFlag(StarfieldModHeader.HeaderFlag.Light));
    }

    [Fact]
    public async Task AnInteriorCellOfALightMaster_CopiedInAroundAChild_CompilesAsAPartialForm()
    {
        CopyHandler.CopySync([new RecordAt(_light, _lightPlaced.ToString())], CopyMode.Override, [_compiledPlugin], replace: false).OnlyLanded();

        using var compiled = await CompiledAfterAsync();
        var cell = compiled.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(sub => sub.Cells).Single(c => c.FormKey == _lightInterior);
        Assert.NotEqual(0, cell.MajorRecordFlagsRaw & PartialFormFlag.Bit);
        Assert.Null(cell.WaterHeight);
        Assert.Equal([_lightPlaced], cell.Temporary.Select(child => child.FormKey));
    }

    [Fact]
    public async Task ClearingPersistent_MovesTheReferenceIntoTheCellItsPositionFallsIn_AHundredUnitsAGridStep()
    {
        var cleared = EditHandler.Set(_compiledPlugin, _wanderer.ToString(), "MajorRecordFlagsRaw", JsonDocument.Parse("0").RootElement);

        Assert.True(cleared.Applied, cleared.Message);
        using var compiled = await CompiledAfterAsync();
        var landed = ExteriorCells(compiled).Single(cell => cell.Temporary.Any(placed => placed.FormKey == _wanderer));
        Assert.Equal(new P2Int(3, 3), landed.Grid.Require().Point);
    }

    [Fact]
    public async Task ACellCreatedOnAStarfieldWorldspace_CompilesAtItsGrid_InTheBlockAndSubBlockItFallsIn()
    {
        var created = CreateHandler.CreateRecordSync(_compiledPlugin, "cell", _world.ToString(), new GridPosition(-9, 33));

        Assert.True(created.Applied, created.Message);
        using var compiled = await CompiledAfterAsync();
        var (block, subBlock, cell) = compiled.Worldspaces[_world].SubCells
            .SelectMany(block => block.Items.SelectMany(subBlock => subBlock.Items.Select(cell => (block, subBlock, cell))))
            .Single(held => held.cell.FormKey.ToString() == created.NewFormKey);
        Assert.Equal(
            ((short)-1, (short)1, (short)-2, (short)4, new P2Int(-9, 33)),
            (block.BlockNumberX, block.BlockNumberY, subBlock.BlockNumberX, subBlock.BlockNumberY, cell.Grid.Require().Point));
    }

    [Fact]
    public void ACellCreatedWhereTheStarfieldWorldspaceHoldsOne_IsRefusedNamingIt()
    {
        var refused = CreateHandler.CreateRecordSync(_compiledPlugin, "cell", _world.ToString(), new GridPosition(0, 0));

        Assert.Equal(RecordEditRefusal.ChildSlotHeldByAnotherRecord, refused.Refusal);
        Assert.Contains(_here.ToString(), refused.Message, StringComparison.Ordinal);
    }

    private IEnumerable<ICellGetter> ExteriorCells(IStarfieldModGetter mod) =>
        mod.Worldspaces[_world].SubCells.SelectMany(block => block.Items).SelectMany(subBlock => subBlock.Items);

    [Fact]
    public async Task ACompile_WhoseMasterHeaderDoesNotRead_IsRefusedNamingTheMasterToFixOrRestore()
    {
        File.WriteAllBytes(Path.Combine(ModFolderOf(_light), LightName), "not a plugin"u8.ToArray());

        var refused = Assert.Single((await CompileHandler.CompileAsync([_compiledPlugin])).Value().Refused);

        Assert.Equal(
            (CompileRefusal.MasterUnreadable,
             $"{CompiledPluginName} could not be compiled: its master {LightName} could not be read: the plugin — unknown: " +
             "Could not read enough data to parse a Mod Header from stream.  Position: 0.  12 remaining < 24 expected. " +
             $"Fix or restore {LightName}, then compile again."),
            (refused.Refusal, refused.Message));
    }

    [Fact]
    public async Task TheMediumFlag_OnAPluginHoldingARecordPastTheMediumRange_RefusesCompileNamingIt()
    {
        var wide = CreatedAt(0x10000);

        var flagged = EditHandler.Set(_compiledPlugin, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement);

        Assert.True(flagged.Applied, flagged.Message);
        var refused = Assert.Single((await CompileHandler.CompileAsync([_compiledPlugin])).Value().Refused);
        Assert.Equal(CompileRefusal.FormIdOutsideFlagLimit, refused.Refusal);
        Assert.Contains(wide.ToString(), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_OnAMediumPluginWithNoFormKeyFreeInItsRange_IsRefusedNamingClearingTheFlag()
    {
        Assert.True(EditHandler.Set(_compiledPlugin, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement).Applied);
        CreatedAt(0xFFFF);

        var result = CreateHandler.CreateRecordSync(_compiledPlugin, "kywd");

        Assert.Equal(
            (RecordEditRefusal.FormKeySpaceExhausted,
             $"{CompiledPluginName} has no FormKey free at or above its Next Object ID, up to 0xFFFF, the last a medium plugin can address. " +
             "Clear the medium flag to draw above it."),
            (result.Refusal, result.Message));
    }

    [Fact]
    public void AFormKeyEdit_PastAMediumPluginsRange_IsRefused()
    {
        Assert.True(EditHandler.Set(_compiledPlugin, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement).Applied);
        var created = CreateHandler.CreateRecordSync(_compiledPlugin, "kywd").NewFormKey.Require();
        var wide = $"010000:{CompiledPluginName}";

        var result = EditHandler.SetFormId(_compiledPlugin, created, wide);

        Assert.Equal(
            (RecordEditRefusal.FormIdOutsideFlagLimit,
             $"{wide} exceeds {CompiledPluginName}'s medium local FormID range — a medium plugin can only address local FormIDs up to 0xFFFF. " +
             "Choose a FormID within that range, or clear the medium flag."),
            (result.Refusal, result.Message));
    }

    private FormKey CreatedAt(uint id)
    {
        var formKey = new FormKey(ModKey.FromFileName(CompiledPluginName), id);
        var created = CreateHandler.CreateRecordSync(_compiledPlugin, "kywd");
        var moved = EditHandler.Set(_compiledPlugin, created.NewFormKey.Require(), "FormKey", JsonSerializer.SerializeToElement(formKey.ToString()));
        Assert.True(moved.Applied, moved.Message);
        return formKey;
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
