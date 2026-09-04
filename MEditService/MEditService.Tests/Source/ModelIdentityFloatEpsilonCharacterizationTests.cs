using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>Mutagen's <c>FillEqualsMask</c> compares floats within a literal 1e-9 band, which only differs
/// from bit-exact very close to zero.</summary>
public sealed class ModelIdentityFloatEpsilonCharacterizationTests
{
    [Fact]
    public void FindFirst_WhenAFloatNearZeroChangesByLessThanTheMasksAbsoluteEpsilon_RefusesViaTheCodecDecider()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");
        npc.HeightMin = 0f;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        // 5e-10 < the mask's 1e-9 absolute epsilon, so EqualsWithin reports these as equal even
        // though the underlying float32 bit patterns genuinely differ.
        var recompiledNpc = new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "SomeNpc", HeightMin = 5e-10f };
        recompiled.Npcs.Add(recompiledNpc);

        Assert.NotEqual(npc.HeightMin, recompiledNpc.HeightMin);

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Equal(npc.FormKey, divergence!.FormKey);
    }
}
