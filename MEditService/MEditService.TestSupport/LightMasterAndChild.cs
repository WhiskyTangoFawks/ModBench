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
}
