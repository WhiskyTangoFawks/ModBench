using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class StarfieldGestureTests : TestInstance
{
    private const string LightName = "Light.esm";
    private const string UnrelatedName = "Unrelated.esm";
    private const string CompiledPluginName = "CompiledPlugin.esp";

    private readonly FormKey _weapon;
    private readonly PluginAddress _light;
    private readonly PluginAddress _unrelated;
    private readonly PluginAddress _compiledPlugin;

    public StarfieldGestureTests()
        : base(GameRelease.Starfield)
    {
        var light = new StarfieldMod(ModKey.FromFileName(LightName), StarfieldRelease.Starfield);
        light.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        _weapon = light.Weapons.AddNew("LightWeapon").FormKey;
        _light = Add(light, "LightMod", compiledPlugin: false);

        _unrelated = Add(new StarfieldMod(ModKey.FromFileName(UnrelatedName), StarfieldRelease.Starfield), "UnrelatedMod", compiledPlugin: false);

        var compiledPlugin = new StarfieldMod(ModKey.FromFileName(CompiledPluginName), StarfieldRelease.Starfield);
        compiledPlugin.Weapons.Add(new Weapon(_weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride" });
        compiledPlugin.ModHeader.MasterReferences.Add(new MasterReference { Master = light.ModKey });
        _compiledPlugin = Add(compiledPlugin, "SourceMod");
    }

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
    public async Task ACompile_WhoseLoadOrderHoldsAnUnrelatedPluginWhoseHeaderDoesNotRead_Lands()
    {
        File.WriteAllBytes(Path.Combine(ModFolderOf(_unrelated), UnrelatedName), "not a plugin"u8.ToArray());

        using var compiled = await CompiledAfterAsync();

        Assert.Equal("LightWeaponOverride", compiled.Weapons[_weapon].EditorID);
    }

    [Fact]
    public async Task ACompile_WhoseMasterHeaderDoesNotRead_IsRefusedNamingTheMasterToFixOrRestore()
    {
        File.WriteAllBytes(Path.Combine(ModFolderOf(_light), LightName), "not a plugin"u8.ToArray());

        var refused = Assert.Single((await CompileHandler.CompileAsync([_compiledPlugin])).Value().Refused);

        Assert.Equal(CompileRefusal.MasterUnreadable, refused.Refusal);
        Assert.StartsWith($"{CompiledPluginName} could not be compiled: its master {LightName} could not be read: ", refused.Message, StringComparison.Ordinal);
        Assert.EndsWith($"Fix or restore {LightName}, then compile again.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFormKeyEdit_PastAMediumPluginsRange_IsRefused()
    {
        Assert.True(EditHandler.Set(_compiledPlugin, Header, "Flags", Json("[\"Medium\"]")).Applied);
        var created = CreateHandler.CreateRecordSync(_compiledPlugin, "kywd").NewFormKey.Require();
        var wide = $"010000:{CompiledPluginName}";

        var result = EditHandler.SetFormId(_compiledPlugin, created, wide);

        Assert.Equal(
            (RecordEditRefusal.FormIdOutsideFlagLimit,
             $"{wide} exceeds {CompiledPluginName}'s medium local FormID range — a medium plugin can only address local FormIDs up to 0xFFFF. " +
             "Choose a FormID within that range, or clear the medium flag."),
            (result.Refusal, result.Message));
    }
}
