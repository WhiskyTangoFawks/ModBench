using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>An in-between count is the failure (ADR-0013): a plugin reading as "412 records" while
/// 1,588 are still being written is worse than absent, since nothing distinguishes it from one that
/// genuinely holds 412.</summary>
public sealed class IndexVisibilityTests
{
    // Ingest reads no live object per column any more, so the window a read can land in is the
    // codec serialize alone; enough records keep it long enough to sample.
    private const int NpcCount = 4000;

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
    public void AReadDuringAnUncommittedWrite_AnswersFromTheCommittedIndex()
    {
        var (repository, _, dir, key) = IndexedBigPlugin();
        try
        {
            using var writerTransaction = repository.Connection.BeginTransaction();
            ExecuteOnWriter(repository, $"DELETE FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = 'Big.esp'");

            var seen = repository.At(RecordRef.Effective).GetRecordTypeCounts(key)
                .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
            Assert.True(seen == NpcCount, $"a read saw {seen} of {NpcCount} records — it joined the writer's uncommitted transaction");
        }
        finally
        {
            repository.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    private static (DuckDbRecordIndex Repository, ModPath Path, string Dir, PluginKey Key) IndexedBigPlugin()
    {
        var (_, modPath, dir) = BuildBigPlugin("Big.esp");
        var reflector = SharedSchemaReflector.Instance;
        var repository = (DuckDbRecordIndex)new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector))
            .Create(GameRelease.Fallout4);
        using var loaded = ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        var key = new PluginKey("Big.esp", PluginOrigin.DataDirectory);
        repository.IndexMod(loaded, Registration.Participating(0), key, modPath.Path);
        return (repository, modPath, dir, key);
    }

    private static void ExecuteOnWriter(DuckDbRecordIndex repository, string sql) =>
        DuckDbSql.ExecuteFor(repository.Connection, sql);

    [Fact]
    public void RegisteredPluginsDuringAnUncommittedWrite_AnswerFromTheCommittedIndex()
    {
        var (repository, _, dir, key) = IndexedBigPlugin();
        try
        {
            using var writerTransaction = repository.Connection.BeginTransaction();
            ExecuteOnWriter(repository, $"DELETE FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = 'Big.esp'");
            Assert.Contains(key, repository.RegisteredPlugins());
        }
        finally
        {
            repository.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SequenceDuringAnUncommittedWrite_AnswersFromTheCommittedIndex()
    {
        var (repository, _, dir, _) = IndexedBigPlugin();
        try
        {
            var committed = repository.Sequence;
            using var writerTransaction = repository.Connection.BeginTransaction();
            ExecuteOnWriter(repository, $"UPDATE {IndexStore.SequenceRelation} SET value = value + 100");
            Assert.Equal(committed, repository.Sequence);
        }
        finally
        {
            repository.Dispose();
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void IndexedContentHashDuringAnUncommittedWrite_AnswersFromTheCommittedIndex()
    {
        var (repository, _, dir, key) = IndexedBigPlugin();
        try
        {
            var committed = repository.IndexedContentHash(key);
            Assert.NotNull(committed);
            using var writerTransaction = repository.Connection.BeginTransaction();
            ExecuteOnWriter(repository, $"DELETE FROM {IndexStore.FilesRelation} WHERE plugin = 'Big.esp'");
            Assert.Equal(committed, repository.IndexedContentHash(key));
        }
        finally
        {
            repository.Dispose();
            Directory.Delete(dir, recursive: true);
        }
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

            // Several readers, because production is several concurrent HTTP requests, not one.
            var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                while (!indexing.IsCancellationRequested)
                {
                    observed.Add(repository.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey("Big.esp", PluginOrigin.DataDirectory))
                        .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0);
                }
            })).ToArray();

            repository.IndexMod(loaded, Registration.Participating(0), new PluginKey(loaded.ModKey.FileName.ToString(), PluginOrigin.DataDirectory));
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
