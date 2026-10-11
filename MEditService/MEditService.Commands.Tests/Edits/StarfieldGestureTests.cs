using System.Text.Json;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;

namespace MEditService.Commands.Tests.Edits;

public sealed class StarfieldGestureTests : IDisposable
{
    private const string LightName = "Light.esm";
    private const string MediumName = "Medium.esm";
    private const string TrackedName = "Tracked.esp";

    private readonly StarfieldInstance _instance = new();
    private readonly FormKey _weapon;
    private readonly FormKey _mediumKeyword;
    private readonly PluginAddress _tracked;

    public StarfieldGestureTests()
    {
        var light = new StarfieldMod(ModKey.FromFileName(LightName), StarfieldRelease.Starfield);
        light.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        _weapon = light.Weapons.AddNew("LightWeapon").FormKey;
        _instance.AddPlugin(light, "LightMod", tracked: false);

        var medium = new StarfieldMod(ModKey.FromFileName(MediumName), StarfieldRelease.Starfield);
        medium.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Medium;
        _mediumKeyword = medium.Keywords.AddNew("MediumKeyword").FormKey;
        _instance.AddPlugin(medium, "MediumMod", tracked: false);

        var tracked = new StarfieldMod(ModKey.FromFileName(TrackedName), StarfieldRelease.Starfield);
        var weapon = new Weapon(_weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride", Keywords = [] };
        weapon.Keywords.Add(_mediumKeyword);
        tracked.Weapons.Add(weapon);
        tracked.ModHeader.MasterReferences.AddRange([new MasterReference { Master = light.ModKey }, new MasterReference { Master = medium.ModKey }]);
        _tracked = _instance.AddPlugin(tracked, "TrackedMod", tracked: true);
    }

    public void Dispose() => _instance.Dispose();

    private string TrackedPath => Path.Combine(_instance.ModFolderOf(_tracked), TrackedName);

    private IStarfieldModDisposableGetter Compiled() =>
        StarfieldMod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(TrackedName), TrackedPath), StarfieldRelease.Starfield,
            new BinaryReadParameters { MasterFlagsLookup = _instance.Added });

    [Fact]
    public async Task AFieldEdit_OnAnOverrideOfALightMastersRecord_CompilesIntoTheStarfieldPlugin()
    {
        var result = _instance.EditHandler.Set(_tracked, _weapon.ToString(), "EditorID", JsonDocument.Parse("\"Edited\"").RootElement);

        Assert.True(result.Applied, result.Message);
        await _instance.CompileHandler.CompileLandedAsync(_tracked);
        using var compiled = Compiled();
        var weapon = compiled.Weapons[_weapon];
        Assert.Equal("Edited", weapon.EditorID);
        Assert.Equal([_mediumKeyword], weapon.Keywords.Require().Select(keyword => keyword.FormKey));
    }

    private sealed class StarfieldInstance() : TestInstance(GameRelease.Starfield)
    {
        public PluginAddress AddPlugin(StarfieldMod mod, string origin, bool tracked) => Add(mod, origin, tracked);
    }
}
