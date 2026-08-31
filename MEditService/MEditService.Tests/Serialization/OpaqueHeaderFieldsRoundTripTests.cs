using MEditService.Core.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog.WorkEngine;

namespace MEditService.Tests.Serialization;

/// <summary>
/// A permanent regression fixture: a synthetic TES4 header carrying every field
/// <see cref="MEditService.Core.Source.ModelIdentity.OpaqueHeaderFields"/> allow-lists — the same
/// opaque-byte-array shape <c>ScopeOverlayDOF.esp</c>'s real INTV subrecord exercises in the wild
/// (that plugin is not present in this repo or environment, hence the synthetic
/// fixture). Isolated at the codec seam
/// (<see cref="RecordTextCodecGeneratorSeed.SerializeWholeMod"/>/<c>DeserializeWholeMod</c>), one level
/// below <c>TrackServiceTests.TrackAsync_WithOpaqueHeaderFieldsSet_TracksSuccessfully</c>'s end-to-end
/// companion — a defect here would show up as a codec-only failure with no Track machinery in the way.
///
/// <para><b><c>Author</c>/<c>Description</c> checked here empirically, not assumed.</b>
/// <c>Mutagen.Bethesda.Core</c>'s <c>ModHeaderWriteLogic</c> (the shared write path every header write
/// goes through) never touches either field, so a divergence on either is a
/// real defect by the same logic as the other five allow-listed fields.</para>
///
/// <para><b><c>TransientTypes</c> is set here too, matching on both sides, despite not being
/// allow-listed</b> (see <c>ModelIdentity.OpaqueHeaderFields</c>' own doc
/// comment and <c>ModelIdentityTests</c>' <c>..._KnownGap_ReturnsNull</c> pair for why a
/// <c>TransientTypes</c> corruption is not detected by this gate at all): kept here to prove the codec
/// itself preserves it correctly even though the round-trip *gate* cannot currently see a corruption of
/// it — a codec question, not a gate-coverage one.</para>
///
/// <para><b>The guard is not vacuous:</b> forcing a dropped opaque field (setting
/// <c>recompiled.ModHeader.INTV = null</c> immediately after <c>DeserializeWholeMod</c> returns — the
/// same forging technique <c>TrackServiceTests</c>' own
/// <c>DeserializeThenCorruptTheNpc</c>/<c>DeserializeThenMutateTheFloat</c> use) fails at the
/// <c>.Value.ToArray()</c> comparison below with
/// <c>System.InvalidOperationException: Nullable object must have a value.</c></para>
/// </summary>
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
