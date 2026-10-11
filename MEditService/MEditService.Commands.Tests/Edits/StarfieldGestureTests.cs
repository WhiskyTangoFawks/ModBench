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

public sealed class StarfieldGestureTests : IDisposable
{
    private const string LightName = "Light.esm";
    private const string MediumName = "Medium.esm";
    private const string UnrelatedName = "Unrelated.esm";
    private const string TrackedName = "Tracked.esp";

    private readonly StarfieldInstance _instance = new();
    private readonly FormKey _weapon;
    private readonly FormKey _lightInterior;
    private readonly FormKey _lightPlaced;
    private readonly FormKey _mediumKeyword;
    private readonly PluginAddress _light;
    private readonly PluginAddress _unrelated;
    private readonly PluginAddress _tracked;

    public StarfieldGestureTests()
    {
        var light = new StarfieldMod(ModKey.FromFileName(LightName), StarfieldRelease.Starfield);
        light.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        _weapon = light.Weapons.AddNew("LightWeapon").FormKey;
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

        _unrelated = _instance.AddPlugin(new StarfieldMod(ModKey.FromFileName(UnrelatedName), StarfieldRelease.Starfield), "UnrelatedMod", tracked: false);

        var tracked = new StarfieldMod(ModKey.FromFileName(TrackedName), StarfieldRelease.Starfield);
        var weapon = new Weapon(_weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride", Keywords = [] };
        weapon.Keywords.Add(_mediumKeyword);
        tracked.Weapons.Add(weapon);
        tracked.ModHeader.MasterReferences.AddRange([new MasterReference { Master = light.ModKey }, new MasterReference { Master = medium.ModKey }]);
        _tracked = _instance.AddPlugin(tracked, "TrackedMod", tracked: true);
    }

    public void Dispose() => _instance.Dispose();

    private static string Header => new FormKey(ModKey.FromFileName(TrackedName), 0).ToString();

    private IStarfieldModDisposableGetter Compiled() =>
        StarfieldMod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(TrackedName), Path.Combine(_instance.ModFolderOf(_tracked), TrackedName)), StarfieldRelease.Starfield,
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
    public async Task ACompile_WhoseLoadOrderHoldsAnUnrelatedPluginWhoseHeaderDoesNotRead_Lands()
    {
        File.WriteAllBytes(Path.Combine(_instance.ModFolderOf(_unrelated), UnrelatedName), "not a plugin"u8.ToArray());

        using var compiled = await CompiledAfterAsync();

        Assert.Equal("LightWeaponOverride", compiled.Weapons[_weapon].EditorID);
    }

    [Fact]
    public async Task TheLightFlag_SetOnTheHeader_CompilesAsALightStarfieldPlugin()
    {
        var result = _instance.EditHandler.Set(_tracked, Header, "IsSmallMaster", JsonDocument.Parse("true").RootElement);

        Assert.True(result.Applied, result.Message);
        using var compiled = await CompiledAfterAsync();
        Assert.True(compiled.ModHeader.Flags.HasFlag(StarfieldModHeader.HeaderFlag.Light));
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
    public async Task ACompile_WhoseMasterHeaderDoesNotRead_IsRefusedNamingTheMasterToFixOrRestore()
    {
        File.WriteAllBytes(Path.Combine(_instance.ModFolderOf(_light), LightName), "not a plugin"u8.ToArray());

        var refused = Assert.Single((await _instance.CompileHandler.CompileAsync([_tracked])).Refused);

        Assert.Equal(
            (CompileRefusal.MasterUnreadable,
             $"{TrackedName} could not be compiled: its master {LightName} could not be read: the plugin — unknown: " +
             "Could not read enough data to parse a Mod Header from stream.  Position: 0.  12 remaining < 24 expected. " +
             $"Fix or restore {LightName}, then compile again."),
            (refused.Refusal, refused.Message));
    }

    [Fact]
    public async Task TheMediumFlag_OnAPluginHoldingARecordPastTheMediumRange_RefusesCompileNamingIt()
    {
        var wide = CreatedAt(0x10000);

        var flagged = _instance.EditHandler.Set(_tracked, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement);

        Assert.True(flagged.Applied, flagged.Message);
        var refused = Assert.Single((await _instance.CompileHandler.CompileAsync([_tracked])).Refused);
        Assert.Equal(
            (CompileRefusal.FormIdOutsideFlagLimit,
             $"{TrackedName} is a medium plugin but holds native FormID(s) outside the medium range (0x0-0xFFFF): {wide}. " +
             "Clear the medium flag, or change the records' FormIDs."),
            (refused.Refusal, refused.Message));
    }

    [Fact]
    public void CreateRecord_OnAMediumPluginWithNoFormKeyFreeInItsRange_IsRefusedNamingClearingTheFlag()
    {
        Assert.True(_instance.EditHandler.Set(_tracked, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement).Applied);
        CreatedAt(0xFFFF);

        var result = _instance.CreateHandler.CreateRecordSync(_tracked, "kywd");

        Assert.Equal(
            (RecordEditRefusal.FormKeySpaceExhausted,
             $"{TrackedName} has no FormKey free at or above its Next Object ID, up to 0xFFFF, the last a medium plugin can address. " +
             "Clear the medium flag in the header to draw above it."),
            (result.Refusal, result.Message));
    }

    [Fact]
    public void AFormKeyEdit_PastAMediumPluginsRange_IsRefused()
    {
        Assert.True(_instance.EditHandler.Set(_tracked, Header, "Flags", JsonDocument.Parse("[\"Medium\"]").RootElement).Applied);
        var created = _instance.CreateHandler.CreateRecordSync(_tracked, "kywd").NewFormKey.Require();
        var wide = $"010000:{TrackedName}";

        var result = _instance.EditHandler.SetFormId(_tracked, created, wide);

        Assert.Equal(
            (RecordEditRefusal.FormIdOutsideFlagLimit,
             $"{wide} exceeds {TrackedName}'s medium local FormID range — a medium plugin can only address local FormIDs up to 0xFFFF. " +
             "Choose a FormID within that range, or clear the medium flag."),
            (result.Refusal, result.Message));
    }

    private FormKey CreatedAt(uint id)
    {
        var formKey = new FormKey(ModKey.FromFileName(TrackedName), id);
        var created = _instance.CreateHandler.CreateRecordSync(_tracked, "kywd");
        var moved = _instance.EditHandler.Set(_tracked, created.NewFormKey.Require(), "FormKey", JsonSerializer.SerializeToElement(formKey.ToString()));
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

    private sealed class StarfieldInstance() : TestInstance(GameRelease.Starfield)
    {
        public PluginAddress AddPlugin(StarfieldMod mod, string origin, bool tracked) => Add(mod, origin, tracked);
    }
}
