using System.Globalization;
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
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class StarfieldGestureTests : IDisposable
{
    private const string LightName = "Light.esm";
    private const string MediumName = "Medium.esm";
    private const string TrackedName = "Tracked.esp";
    private const int Persistent = 0x0400;
    private const float CellWidth = 100f;

    private readonly StarfieldInstance _instance = new();
    private readonly FormKey _weapon;
    private readonly FormKey _lightKeyword;
    private readonly FormKey _lightInterior;
    private readonly FormKey _lightPlaced;
    private readonly FormKey _mediumKeyword;
    private readonly FormKey _world;
    private readonly FormKey _exterior;
    private readonly FormKey _mover;
    private readonly PluginAddress _light;
    private readonly PluginAddress _tracked;

    public StarfieldGestureTests()
    {
        var light = new StarfieldMod(ModKey.FromFileName(LightName), StarfieldRelease.Starfield);
        light.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        _weapon = light.Weapons.AddNew("LightWeapon").FormKey;
        _lightKeyword = light.Keywords.AddNew("LightKeyword").FormKey;
        var interior = new Cell(light) { EditorID = "LightInterior", Flags = Cell.Flag.IsInteriorCell, WaterHeight = 5f };
        var placed = new PlacedObject(light) { EditorID = "LightPlaced", Position = new P3Float(1, 2, 3) };
        interior.Temporary.Add(placed);
        light.Cells.Records.Add(Interior(interior));
        (_lightInterior, _lightPlaced) = (interior.FormKey, placed.FormKey);
        _light = _instance.AddPlugin(light, "LightMod", tracked: false);

        var medium = new StarfieldMod(ModKey.FromFileName(MediumName), StarfieldRelease.Starfield);
        medium.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Medium;
        _mediumKeyword = medium.Keywords.AddNew("MediumKeyword").FormKey;
        _instance.AddPlugin(medium, "MediumMod", tracked: false);

        var tracked = new StarfieldMod(ModKey.FromFileName(TrackedName), StarfieldRelease.Starfield);
        var weapon = new Weapon(_weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride", Keywords = [] };
        weapon.Keywords.Add(_mediumKeyword);
        tracked.Weapons.Add(weapon);
        var world = new Worldspace(tracked) { EditorID = "TrackedWorld" };
        var exterior = new Cell(tracked) { EditorID = "Exterior", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        var mover = new PlacedObject(tracked) { EditorID = "Mover", Position = new P3Float(5.5f * CellWidth, 6.5f * CellWidth, 0) };
        exterior.Temporary.Add(mover);
        world.SubCells.Add(Exterior(exterior));
        tracked.Worldspaces.Add(world);
        (_world, _exterior, _mover) = (world.FormKey, exterior.FormKey, mover.FormKey);
        tracked.ModHeader.MasterReferences.AddRange([new MasterReference { Master = light.ModKey }, new MasterReference { Master = medium.ModKey }]);
        _tracked = _instance.AddPlugin(tracked, "TrackedMod", tracked: true);
    }

    public void Dispose() => _instance.Dispose();

    private string TrackedPath => Path.Combine(_instance.ModFolderOf(_tracked), TrackedName);

    private IStarfieldModDisposableGetter Compiled() =>
        StarfieldMod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(TrackedName), TrackedPath), StarfieldRelease.Starfield,
            new BinaryReadParameters { MasterFlagsLookup = _instance.Added });

    private async Task<IStarfieldModDisposableGetter> CompiledAfterAsync()
    {
        await _instance.CompileHandler.CompileLandedAsync(_tracked);
        return Compiled();
    }

    [Fact]
    public async Task AFieldEdit_OnAnOverrideOfALightMastersRecord_CompilesIntoTheStarfieldPlugin()
    {
        var result = _instance.EditHandler.Set(_tracked, _weapon.ToString(), "EditorID", JsonDocument.Parse("\"Edited\"").RootElement);

        Assert.True(result.Applied, result.Message);
        using var compiled = await CompiledAfterAsync();
        var weapon = compiled.Weapons[_weapon];
        Assert.Equal("Edited", weapon.EditorID);
        Assert.Equal([_mediumKeyword], weapon.Keywords.Require().Select(keyword => keyword.FormKey));
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightStarfieldPlugin()
    {
        var header = new FormKey(ModKey.FromFileName(TrackedName), 0).ToString();

        var result = _instance.EditHandler.Set(_tracked, header, "IsSmallMaster", JsonDocument.Parse("true").RootElement);

        Assert.True(result.Applied, result.Message);
        using var compiled = await CompiledAfterAsync();
        Assert.True(compiled.ModHeader.Flags.HasFlag(StarfieldModHeader.HeaderFlag.Light));
    }

    [Fact]
    public async Task ALightMastersRecord_CopiedAsOverride_CompilesUnderItsFormKey()
    {
        _instance.CopyHandler.CopySync([new RecordAt(_light, _lightKeyword.ToString())], CopyMode.Override, [_tracked], replace: false).OnlyLanded();

        using var compiled = await CompiledAfterAsync();
        Assert.Equal("LightKeyword", compiled.Keywords[_lightKeyword].EditorID);
    }

    [Fact]
    public async Task ALightMastersRecord_CopiedAsNew_CompilesAsTheTrackedPluginsOwn()
    {
        _instance.CopyHandler.CopySync([new RecordAt(_light, _lightKeyword.ToString())], CopyMode.New, [_tracked], replace: false).OnlyLanded();

        using var compiled = await CompiledAfterAsync();
        var copy = Assert.Single(compiled.Keywords);
        Assert.Equal(ModKey.FromFileName(TrackedName), copy.FormKey.ModKey);
    }

    [Fact]
    public async Task AnInteriorCellOfALightMaster_CopiedInAroundAChild_CompilesAsAPartialForm()
    {
        _instance.CopyHandler.CopySync([new RecordAt(_light, _lightPlaced.ToString())], CopyMode.Override, [_tracked], replace: false).OnlyLanded();

        using var compiled = await CompiledAfterAsync();
        var cell = compiled.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(sub => sub.Cells).Single(c => c.FormKey == _lightInterior);
        Assert.NotEqual(0, cell.MajorRecordFlagsRaw & PartialFormFlag.Bit);
        Assert.Null(cell.WaterHeight);
        Assert.Equal([_lightPlaced], cell.Temporary.Select(child => child.FormKey));
    }

    [Fact]
    public async Task ARecordCreated_CompilesAtTheNextObjectId()
    {
        var created = _instance.CreateHandler.CreateRecordSync(_tracked, "weap");

        Assert.True(created.Applied, created.Message);
        using var compiled = await CompiledAfterAsync();
        Assert.Contains(FormKey.Factory(created.NewFormKey.Require()), compiled.Weapons.Select(weapon => weapon.FormKey));
    }

    [Fact]
    public async Task AReferenceCreatedOnAnExteriorCell_CompilesAtTheCellsCentre()
    {
        var created = _instance.CreateHandler.CreateRecordSync(_tracked, "refr", _exterior.ToString());

        Assert.True(created.Applied, created.Message);
        using var compiled = await CompiledAfterAsync();
        var placed = ExteriorCells(compiled).Single(cell => cell.FormKey == _exterior).Temporary.Single(child => child.FormKey == FormKey.Factory(created.NewFormKey.Require()));
        Assert.Equal(new P3Float(1.5f * CellWidth, 2.5f * CellWidth, 0), ((IPlacedObjectGetter)placed).Position);
    }

    [Fact]
    public async Task Persistent_SetThenCleared_CompilesTheReferenceIntoTheCellAtItsPosition()
    {
        SetFlags(Persistent);
        SetFlags(0);

        using var compiled = await CompiledAfterAsync();
        var holder = ExteriorCells(compiled).Single(cell => cell.Temporary.Any(child => child.FormKey == _mover));
        Assert.Equal(new P2Int(5, 6), holder.Grid.Require().Point);
    }

    [Fact]
    public async Task Persistent_Set_CompilesTheReferenceIntoTheWorldspacesPersistentCell()
    {
        SetFlags(Persistent);

        using var compiled = await CompiledAfterAsync();
        Assert.Contains(_mover, compiled.Worldspaces[_world].TopCell.Require().Persistent.Select(child => child.FormKey));
    }

    [Fact]
    public async Task AnOverrideDeleted_CompilesOutOfThePlugin()
    {
        Assert.Single(_instance.DeleteHandler.DeleteRecordsSync([new RecordAt(_tracked, _weapon.ToString())]).Landed);

        using var compiled = await CompiledAfterAsync();
        Assert.Empty(compiled.Weapons);
    }

    private void SetFlags(int raw)
    {
        var result = _instance.EditHandler.Edit(
            _tracked, _mover.ToString(), SetAt(JsonDocument.Parse(raw.ToString(CultureInfo.InvariantCulture)).RootElement, Member("MajorRecordFlagsRaw")));
        Assert.True(result.Applied, result.Message);
    }

    private static IEnumerable<ICellGetter> ExteriorCells(IStarfieldModGetter mod) =>
        mod.Worldspaces.SelectMany(world => world.SubCells).SelectMany(block => block.Items).SelectMany(sub => sub.Items);

    private static CellBlock Interior(Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        return block;
    }

    private static WorldspaceBlock Exterior(Cell cell)
    {
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(cell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        return block;
    }

    private sealed class StarfieldInstance() : TestInstance(GameRelease.Starfield)
    {
        public PluginAddress AddPlugin(StarfieldMod mod, string origin, bool tracked) => Add(mod, origin, tracked);
    }
}
