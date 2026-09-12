using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.RealData;

/// <summary>The fixture is Mutagen-written, so there is no first-write normalization gap, and
/// write1 == write2 alone is blind to a defect reproduced on every write.</summary>
public sealed class BinaryRoundTripGateTests
{
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

    // Built fresh from the plugin's current on-disk state each call, the same shape IndexProjector
    // builds from a live load order.
    private static async Task ProductionSave(string pluginPath, PluginWriter writer)
    {
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), pluginPath), GameRelease.Fallout4);
        var linkCache = TypedLinkCacheFactory.Create([overlay], GameRelease.Fallout4);
        string[] loadOrder = [CutDownPluginFixture.PluginFileName, "Fallout4.esm"];

        await writer.SaveAsync(pluginPath, GameRelease.Fallout4, loadOrder);
    }

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
