using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.TestSupport;

/// <summary>Perks whose entry point spells its actor value parameter as two floats: the malformed-plugin scan diagnoses each, and Mutagen cannot read them.</summary>
public static class MisshapedPerks
{
    private static readonly byte[] ActorValueParameter = [.. "EPFT"u8, 1, 0, 8];
    private const byte TwoFloatsParameter = 2;

    public static void Add(Fallout4Mod mod, string editorId) =>
        mod.Perks.AddNew(editorId).Effects.Add(ActorValueEntry());

    internal static PerkEntryPointModifyActorValue ActorValueEntry() => new()
    {
        Modification = PerkEntryPointModifyActorValue.ModificationType.MultiplyOnePlusAVMult,
    };

    /// <summary>Every perk <see cref="Add"/> put in the written plugin at <paramref name="pluginPath"/>, misshaped in place.</summary>
    public static void Misshape(string pluginPath) => File.WriteAllBytes(pluginPath, Misshape(File.ReadAllBytes(pluginPath)));

    internal static byte[] Misshape(byte[] pluginBytes)
    {
        var bytes = (byte[])pluginBytes.Clone();
        var patched = 0;
        for (var at = 0; at <= bytes.Length - ActorValueParameter.Length; at++)
        {
            if (!bytes.AsSpan(at, ActorValueParameter.Length).SequenceEqual(ActorValueParameter)) continue;
            bytes[at + ActorValueParameter.Length - 1] = TwoFloatsParameter;
            patched++;
        }
        return patched > 0 ? bytes : throw new InvalidOperationException("No actor value EPFT found to misshape.");
    }
}
