using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Codec.Tests.Serialization;

/// <summary>Synthetic header because <c>ScopeOverlayDOF.esp</c> is not in this repo. Author and Description
/// are checked empirically: <c>ModHeaderWriteLogic</c> never touches either.</summary>
public sealed class OpaqueHeaderFieldsRoundTripTests
{
    private static T Require<T>(T? value, string name) where T : struct =>
        value ?? throw new InvalidOperationException($"Expected '{name}' to be present.");

    [Fact]
    public async Task WholeModJsonRoundTrip_OfEveryOpaqueHeaderField_SurvivesByteForByte()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("OpaqueHeader.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };
        mod.ModHeader.INCC = 42;
        mod.ModHeader.TypeOffsets = new byte[] { 9, 8, 7, 6, 5 };
        mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
        mod.ModHeader.Screenshot = new byte[] { 4, 5, 6, 7, 8, 9 };
        mod.ModHeader.Author = "Distinguishable Author Value";
        mod.ModHeader.Description = "Distinguishable Description Value";
        mod.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });

        var folder = Directory.CreateTempSubdirectory("medit-568-opaqueheader-").FullName;
        try
        {
            await RecordTextCodecGeneratorSeed.SerializeWholeMod(mod, folder, InlineWorkDropoff.Instance, CancellationToken.None);
            var recompiled = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, CancellationToken.None);

            Assert.Equal(Require(mod.ModHeader.INTV, "INTV").ToArray(), Require(recompiled.ModHeader.INTV, "INTV").ToArray());
            Assert.Equal(mod.ModHeader.INCC, recompiled.ModHeader.INCC);
            Assert.Equal(Require(mod.ModHeader.TypeOffsets, "TypeOffsets").ToArray(), Require(recompiled.ModHeader.TypeOffsets, "TypeOffsets").ToArray());
            Assert.Equal(Require(mod.ModHeader.Deleted, "Deleted").ToArray(), Require(recompiled.ModHeader.Deleted, "Deleted").ToArray());
            Assert.Equal(Require(mod.ModHeader.Screenshot, "Screenshot").ToArray(), Require(recompiled.ModHeader.Screenshot, "Screenshot").ToArray());
            Assert.Equal(mod.ModHeader.Author, recompiled.ModHeader.Author);
            Assert.Equal(mod.ModHeader.Description, recompiled.ModHeader.Description);
            Assert.Single(recompiled.ModHeader.TransientTypes);
            Assert.Equal(7u, recompiled.ModHeader.TransientTypes[0].FormType);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
