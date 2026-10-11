using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using Noggog;

namespace MEditService.TestSupport;

/// <summary>A Starfield light master holding one weapon, and a plugin overriding it: a plugin Mutagen
/// reads only with its master's style.</summary>
public static class LightMasterAndChild
{
    public static readonly ModKey Master = ModKey.FromFileName("Light.esm");
    public static readonly ModKey Child = ModKey.FromFileName("Child.esp");
    public static readonly FormKey Weapon = new(Master, 0x801);

    public static (string Master, string Child) Write(string folder)
    {
        var master = new StarfieldMod(Master, StarfieldRelease.Starfield);
        master.ModHeader.Flags |= StarfieldModHeader.HeaderFlag.Light;
        master.Weapons.Add(new Weapon(Weapon, StarfieldRelease.Starfield) { EditorID = "LightWeapon" });
        var masterPath = Path.Combine(folder, Master.FileName);
        master.WriteToBinary(masterPath);

        var child = new StarfieldMod(Child, StarfieldRelease.Starfield);
        child.ModHeader.MasterReferences.Add(new MasterReference { Master = Master });
        child.Weapons.Add(new Weapon(Weapon, StarfieldRelease.Starfield) { EditorID = "LightWeaponOverride" });
        var childPath = Path.Combine(folder, Child.FileName);
        child.WriteToBinary(childPath, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.NoCheck,
            MasterFlagsLookup = new Cache<IModMasterStyledGetter, ModKey>(m => m.ModKey) { master },
        });
        return (masterPath, childPath);
    }

    /// <summary>Both written into <paramref name="folder"/>, as the game's own plugins in load order.</summary>
    public static LoadOrderSnapshot LoadOrderIn(string folder)
    {
        var (masterPath, childPath) = Write(folder);
        return SnapshotPlugins.Snapshot(folder, null, GameRelease.Starfield,
        [
            new LoadOrderEntry(Master.FileName, masterPath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(Child.FileName, childPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ]);
    }

    public static RegisteredPlugin ChildIn(LoadOrderSnapshot loadOrder) =>
        loadOrder.Plugin(new PluginAddress(Child.FileName, PluginOrigin.DataDirectory)) ?? throw new InvalidOperationException($"{Child} is not in the load order.");
}
