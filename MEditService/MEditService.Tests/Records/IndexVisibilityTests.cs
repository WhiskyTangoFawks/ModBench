using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>An in-between count is the failure (ADR-0035): a plugin reading as "412 records" while
/// 1,588 are still being written is worse than absent, since nothing distinguishes it from one that
/// genuinely holds 412.</summary>
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
                    observed.Add(repository.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey("Big.esp", PluginOrigin.DataDirectory))
                        .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
                }
            })).ToArray();

            repository.Index(loaded, Registration.Participating(0), new PluginKey(loaded.ModKey.FileName.ToString(), PluginOrigin.DataDirectory));
            await indexing.CancelAsync();
            await Task.WhenAll(readers);

            // If reads ever block behind the indexer's transaction the sample count collapses and the assertion
            // below starts passing for the wrong reason. It also is the "reads are served throughout the load"
            // property, measured where it originates.
            Assert.True(observed.Count > 50, $"only {observed.Count} reads completed during indexing — reads are being blocked by it");

            // Sound in one direction only: an intermediate count can be missed, but one that is seen is always
            // a real defect. This can fail to catch a regression; it cannot report one that is not there.
            Assert.All(observed, count => Assert.True(
                count is 0 or NpcCount,
                $"a read observed {count} of {NpcCount} records — a partially-indexed plugin was visible"));
            Assert.Equal(NpcCount, repository.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey("Big.esp", PluginOrigin.DataDirectory))
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
