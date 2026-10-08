using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Perks whose entry point spells its actor value parameter as two floats, as
/// SKI_PlasmaAutocannon.esp spells one: the malformed-plugin scan diagnoses each, and Mutagen cannot
/// read them.</summary>
internal static class MisshapedPerks
{
    private static readonly byte[] ActorValueParameter = [.. "EPFT"u8, 1, 0, 8];
    private const byte TwoFloatsParameter = 2;

    internal static void Add(Fallout4Mod mod, string editorId) =>
        mod.Perks.AddNew(editorId).Effects.Add(new PerkEntryPointModifyActorValue
        {
            Modification = PerkEntryPointModifyActorValue.ModificationType.MultiplyOnePlusAVMult,
        });

    /// <summary>Every perk <see cref="Add"/> put in the written plugin at <paramref name="pluginPath"/>,
    /// misshaped in place.</summary>
    internal static void Misshape(string pluginPath)
    {
        var bytes = File.ReadAllBytes(pluginPath);
        for (var at = 0; at <= bytes.Length - ActorValueParameter.Length; at++)
        {
            if (bytes.AsSpan(at, ActorValueParameter.Length).SequenceEqual(ActorValueParameter))
                bytes[at + ActorValueParameter.Length - 1] = TwoFloatsParameter;
        }
        File.WriteAllBytes(pluginPath, bytes);
    }
}
