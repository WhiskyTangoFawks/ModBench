using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.RealData;

/// <summary>
/// Permanent gate (#369): a binary round trip on the committed real-data subset
/// (<see cref="CutDownPluginFixture"/>) must not silently corrupt a plugin. Runs unconditionally
/// in the default suite (no environment gate, unlike <see cref="RealInstallSmokeTests"/>).
///
/// Both tests assert two properties separately — <c>original == write1</c> and
/// <c>write1 == write2</c> — deliberately stronger than AC1's bare "write1 == write2" asks for:
/// the fixture is itself Mutagen-written, so there is no legitimate first-write normalization gap
/// (measured: holds on both seams below, at both the 0.53.1 pin and the 0.54.0 pin this gate
/// exists to catch). <c>write1 == write2</c> alone is structurally blind to a defect that
/// reproduces identically on every write — e.g. a bump that silently drops the same marker every
/// time stays green under that comparison alone — whereas <c>original == write1</c> catches it.
/// Asserting the two separately (not just comparing original to write2) means a failure names
/// which property broke.
///
/// A red result here means a human judges the next Mutagen bump before it lands — not that every
/// bump is forbidden. A release could in principle reorder subrecords benignly (ADR-0041 wants
/// bumps gated, not banned).
/// </summary>
public sealed class BinaryRoundTripGateTests
{
    /// <summary>
    /// Guards the production save path: <see cref="PluginWriter.SaveAsync"/> called the way
    /// <c>SessionManager.SavePlugin</c> actually calls it — a real link cache and an explicit
    /// master-writing order (#337/ADR-0038), not the bare defaults <see cref="PluginWriter"/> falls
    /// back to when both are omitted.
    ///
    /// This test does <b>not</b> go red on Mutagen 0.54.0's known ObjectTemplate-duplication
    /// regression (spike #359) — confirmed by direct investigation, including editing one of the
    /// four affected weapons through this exact seam. The regression is confined to the lazy
    /// binary-overlay reader (see <see cref="LazyOverlayReloadAndRewrite_ProducesByteIdenticalOutput"/>
    /// for the mechanism); <c>ModFactory.ImportSetter</c> resolves to <c>Fallout4Mod.CreateFromBinary</c>
    /// — a genuine deep parse — which never consults the ordering the overlay's bug depends on. This
    /// test is therefore currently unfalsified by any known defect — it exists to pin the production
    /// save path's own stability. Do not read a green run here as evidence 0.54.0 is safe to adopt;
    /// that question belongs to the sibling test.
    /// </summary>
    [Fact]
    public async Task SaveAsync_ReloadAndResave_ProducesByteIdenticalOutput()
    {
        var workDir = Directory.CreateTempSubdirectory("medit-roundtrip-save-");
        try
        {
            var pluginPath = Path.Combine(workDir.FullName, CutDownPluginFixture.PluginFileName);
            File.Copy(CutDownPluginFixture.PluginPath, pluginPath);
            var original = await File.ReadAllBytesAsync(pluginPath);

            var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);

            await ProductionSave(pluginPath, writer);
            var write1 = await File.ReadAllBytesAsync(pluginPath);

            // Reloads exactly the bytes write1 produced (SaveAsync re-imports from pluginPath on
            // disk each call) and writes again.
            await ProductionSave(pluginPath, writer);
            var write2 = await File.ReadAllBytesAsync(pluginPath);

            Assert.True(original.SequenceEqual(write1),
                $"First save already diverges from the source: original {original.Length:N0} B vs write1 {write1.Length:N0} B.");
            Assert.True(write1.SequenceEqual(write2),
                $"Save round-trip is not byte-stable: write1 {write1.Length:N0} B vs write2 {write2.Length:N0} B.");
        }
        finally
        {
            workDir.Delete(recursive: true);
        }
    }

    // Link cache + explicit master-writing order, built fresh from pluginPath's current on-disk
    // state each call — the same shape SessionManager.BuildTypedLinkCache/MastersWritingOrder build
    // from the live session, just for this test's single-plugin "session". The subset's single
    // declared master ("Fallout4.esm") needs no on-disk content of its own here: the order list only
    // orders names in the header's master list, it doesn't need those masters loaded to do so.
    private static async Task ProductionSave(string pluginPath, PluginWriter writer)
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), pluginPath), GameRelease.Fallout4);
        var linkCache = TypedLinkCacheFactory.Create([overlay], GameRelease.Fallout4);
        string[] loadOrder = [CutDownPluginFixture.PluginFileName, "Fallout4.esm"];

        await writer.SaveAsync(pluginPath, GameRelease.Fallout4, loadOrder);
    }

    /// <summary>
    /// Guards the lazy binary-overlay reader (<c>Fallout4ModBinaryOverlay</c>, reached via
    /// <c>Fallout4Mod.CreateFromBinaryOverlay</c> or, equivalently, <c>ModFactory.ImportGetter</c>)
    /// through a write cycle. Root cause (established from source and measurement): Mutagen 0.54.0
    /// alphabetized <c>ObjectTemplate_Registration.AllRecordTypes</c> from <c>(OBTF, FULL, OBTS)</c>
    /// to <c>(FULL, OBTF, OBTS)</c>; the overlay's item-boundary rule
    /// (<c>PluginBinaryOverlay.ParseRecordLocationsInternal</c>, which starts a new item whenever
    /// <c>AllRecordTypes.IndexOf</c> fails to increase) therefore splits every on-disk
    /// <c>OBTF FULL OBTS</c> template in two, and the write faithfully serializes the inflated list
    /// (confirmed failing on this exact fixture at the 0.54.0 pin: 767,753 -&gt; 769,026 -&gt; 770,299 B,
    /// +1,273 B on each of the two writes). <c>Fallout4Mod.CreateFromBinary</c> — the deep parse
    /// <see cref="PluginWriter"/> actually uses (see the sibling test above) — never consults that
    /// ordering and is immune.
    ///
    /// This is not a canary on a path our codebase doesn't use: <c>GameSession</c>'s read/indexing
    /// path opens every session plugin via <c>ModFactory.ImportGetter</c> (logged there as "Opening
    /// binary overlay"), which resolves to the exact same <c>Fallout4ModBinaryOverlay</c> type this
    /// test exercises. This test only pins that reader's write-back stability, not read-side
    /// correctness — see #369's report for the read-side implication.
    /// </summary>
    [Fact]
    public async Task LazyOverlayReloadAndRewrite_ProducesByteIdenticalOutput()
    {
        var workDir = Directory.CreateTempSubdirectory("medit-roundtrip-overlay-");
        try
        {
            var sourcePath = Path.Combine(workDir.FullName, CutDownPluginFixture.PluginFileName);
            File.Copy(CutDownPluginFixture.PluginPath, sourcePath);
            var original = await File.ReadAllBytesAsync(sourcePath);

            var write1Path = await OverlayReadAndWrite(sourcePath, workDir.FullName, "w1");
            var write1 = await File.ReadAllBytesAsync(write1Path);

            var write2Path = await OverlayReadAndWrite(write1Path, workDir.FullName, "w2");
            var write2 = await File.ReadAllBytesAsync(write2Path);

            Assert.True(original.SequenceEqual(write1),
                $"First write already diverges from the source: original {original.Length:N0} B vs write1 {write1.Length:N0} B.");
            Assert.True(write1.SequenceEqual(write2),
                $"Overlay round-trip is not byte-stable: write1 {write1.Length:N0} B vs write2 {write2.Length:N0} B.");
        }
        finally
        {
            workDir.Delete(recursive: true);
        }
    }

    private static async Task<string> OverlayReadAndWrite(string sourcePath, string workDir, string label)
    {
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), sourcePath), Fallout4Release.Fallout4);
        var outDir = Directory.CreateDirectory(Path.Combine(workDir, label)).FullName;
        var outPath = Path.Combine(outDir, CutDownPluginFixture.PluginFileName);
        await mod.BeginWrite
            .ToPath(outPath)
            .WithLoadOrderFromHeaderMasters()
            .WithDataFolder((DirectoryPath?)null)
            .WriteAsync();
        return outPath;
    }
}
