using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// ADR-0042 decision 2's own documented "known limitation, not yet closed": Mutagen's generated
/// <c>FillEqualsMask</c> compares <c>Single</c> fields with <c>Noggog.FloatExt.EqualsWithin</c>, a
/// literal 1e-9 absolute-epsilon tolerance band (<c>Math.Abs(a - b) &lt; within</c>, confirmed by
/// reading <c>FloatExt.cs</c>) — not the bit-exact comparison the "no tolerance band" language
/// elsewhere in that decision otherwise promises. One ulp of a float32 at magnitude <c>m</c> is
/// ≈ <c>m</c> × 1.19e-7, so 1e-9 is mathematically equivalent to bit-exact for any
/// <c>|value| ≳ 0.01</c> — this class exists to pin the one place it genuinely is not: values very
/// close to zero. A sub-epsilon mutation there is currently accepted (not refused), and this test
/// characterizes that as it stands today, so the eventual decision on it (#564: accept the epsilon
/// as-is, or bypass the mask for bit-exact numeric comparison) has a test to flip rather than an
/// undocumented gap to rediscover.
/// </summary>
public sealed class ModelIdentityFloatEpsilonCharacterizationTests
{
    [Fact]
    public void FindFirst_WhenAFloatNearZeroChangesByLessThanTheMasksAbsoluteEpsilon_CurrentlyReturnsNull()
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

        Assert.Null(divergence);
    }
}
