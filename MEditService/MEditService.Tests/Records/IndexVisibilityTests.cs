using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// ADR-0035: a plugin becomes readable at the instant it is indexed, and never before it is
/// whole. Progressive loading is what makes this observable — reads arrive *during* indexing.
///
/// An in-between count is the failure this guards: a plugin that reads as "412 records" while its
/// remaining 1,588 are still being written is worse than one that reads as absent, because nothing
/// distinguishes it from a plugin that genuinely holds 412.
/// </summary>
public sealed class IndexVisibilityTests
{
    private const int NpcCount = 2000;

    private static (Fallout4Mod Mod, ModPath Path, string Dir) BuildBigPlugin(string name)
    {
        var dir = Path.Combine(Path.GetTempPath(), $"idx-vis-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        for (int i = 0; i < NpcCount; i++) mod.Npcs.AddNew($"Npc{i:D4}");
        var path = Path.Combine(dir, name);
        mod.WriteToBinary(path);
        return (mod, new ModPath(ModKey.FromFileName(name), path), dir);
    }

    [Fact]
    public async Task AReadDuringIndexing_NeverSeesAPartiallyIndexedPlugin()
    {
        var (_, modPath, dir) = BuildBigPlugin("Big.esp");
        try
        {
            var reflector = SharedSchemaReflector.Instance;
            using var repository = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector))
                .Create(GameRelease.Fallout4);
            using var loaded = ModFactory.ImportGetter(modPath, GameRelease.Fallout4);

            var observed = new System.Collections.Concurrent.ConcurrentBag<int>();
            using var indexing = new CancellationTokenSource();

            // Several readers, because production is several concurrent HTTP requests against one
            // connection, not one.
            var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                while (!indexing.IsCancellationRequested)
                {
                    observed.Add(repository.GetRecordTypeCounts(new PluginKey("Big.esp", PluginOrigin.DataDirectory))
                        .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
                }
            })).ToArray();

            repository.Index(loaded, Registration.Participating(0), new PluginKey(loaded.ModKey.FileName.ToString(), PluginOrigin.DataDirectory));
            await indexing.CancelAsync();
            await Task.WhenAll(readers);

            // Guards this test against going hollow: if a future change makes reads block behind the
            // indexer's transaction, the sample count collapses and the assertion below would start
            // passing for the wrong reason — it would be verifying nothing rather than verifying
            // isolation. It also *is* the "reads are served throughout the load" property, measured
            // at the level where it originates.
            Assert.True(observed.Count > 50, $"only {observed.Count} reads completed during indexing — reads are being blocked by it");

            // Sound in one direction only: an intermediate count can be missed, but one that is
            // seen is always a real defect. That asymmetry is the point — this can fail to catch a
            // regression, it cannot report one that is not there.
            Assert.All(observed, count => Assert.True(
                count is 0 or NpcCount,
                $"a read observed {count} of {NpcCount} records — a partially-indexed plugin was visible"));
            Assert.Equal(NpcCount, repository.GetRecordTypeCounts(new PluginKey("Big.esp", PluginOrigin.DataDirectory))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
