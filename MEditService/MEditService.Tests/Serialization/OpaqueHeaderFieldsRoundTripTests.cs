using MEditService.Core.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.Serialization;

/// <summary>Synthetic header because <c>ScopeOverlayDOF.esp</c> is not in this repo. Author and Description
/// are checked empirically: <c>ModHeaderWriteLogic</c> never touches either.</summary>
public sealed class OpaqueHeaderFieldsRoundTripTests
{
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

            Assert.Equal(mod.ModHeader.INTV!.Value.ToArray(), recompiled.ModHeader.INTV!.Value.ToArray());
            Assert.Equal(mod.ModHeader.INCC, recompiled.ModHeader.INCC);
            Assert.Equal(mod.ModHeader.TypeOffsets!.Value.ToArray(), recompiled.ModHeader.TypeOffsets!.Value.ToArray());
            Assert.Equal(mod.ModHeader.Deleted!.Value.ToArray(), recompiled.ModHeader.Deleted!.Value.ToArray());
            Assert.Equal(mod.ModHeader.Screenshot!.Value.ToArray(), recompiled.ModHeader.Screenshot!.Value.ToArray());
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
