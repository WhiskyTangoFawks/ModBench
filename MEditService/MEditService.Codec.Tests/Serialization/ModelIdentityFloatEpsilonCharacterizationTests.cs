using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ModelIdentityFloatEpsilonCharacterizationTests
{
    [Fact]
    public void FindFirst_WhenAFloatNearZeroChangesByLessThanTheMasksAbsoluteEpsilon_RefusesViaTheCodecDecider_BecauseMutagensFillEqualsMaskComparesFloatsWithinALiteral1e9BandThatOnlyDiffersFromBitExactVeryCloseToZero()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");
        npc.HeightMin = 0f;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        const float BelowTheMasksAbsoluteEpsilonSoEqualsWithinReportsEqualThoughTheFloat32BitPatternsDiffer = 5e-10f;
        var recompiledNpc = new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "SomeNpc", HeightMin = BelowTheMasksAbsoluteEpsilonSoEqualsWithinReportsEqualThoughTheFloat32BitPatternsDiffer };
        recompiled.Npcs.Add(recompiledNpc);

        Assert.NotEqual(npc.HeightMin, recompiledNpc.HeightMin);

        var divergence = ModelIdentity.FindFirstDivergence(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Equal(npc.FormKey, divergence.FormKey);
    }
}
