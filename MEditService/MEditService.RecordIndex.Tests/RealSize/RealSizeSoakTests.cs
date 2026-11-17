using System.Globalization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.RealSize;

[Collection(RealSizeCollection.Name)]
public sealed class RealSizeSoakTests(RealSizeIndex realSize)
{
    private const int Rounds = 6;
    private const int DocumentsWritten = 200;
    private const int DocumentsDeleted = 40;
    private const long SmallBound = 64L * 1024 * 1024;
    private const long UnevictableBound = 16L * 1024 * 1024;

    // What a read in flight is using, or the cache of the file's blocks: both go to the limit and give way, so neither is a holder.
    private static readonly string[] WorkingMemory = ["BASE_TABLE", "HASH_TABLE", "ALLOCATOR", "ORDER_BY"];
    private static readonly int[] UninstalledRanks = [3, 11, 150];

    private OpenedIndex Index => realSize.Index;

    private RealSizeModlist Modlist => realSize.Modlist;

    [RealSizeFact]
    public void ASessionOfEveryOperationKind_LeavesTheEnginesMemoryWhereItStarted_AndEveryReadAnswers() => Soak(readsInFlight: false);

    [RealSizeFact]
    public void ASessionOfEveryOperationKindWithAReadAlwaysInFlight_LeavesTheEnginesMemoryAndTheWalWhereTheyStarted() => Soak(readsInFlight: true);

    private void Soak(bool readsInFlight)
    {
        _ = Index;
        Selects();
        Settle(readsInFlight);
        var started = Sample();
        Report("start", started);
        using var reading = readsInFlight ? new ReadsInFlight(Index.Queries) : null;

        var operations = new (string Name, Action Run)[]
        {
            ("select", Selects),
            ("write", Writes),
            ("delete", Deletes),
            ("compile", Compiles),
            ("uninstall", Uninstalls),
        };
        for (var round = 0; round < Rounds; round++)
        {
            foreach (var (name, run) in operations)
            {
                run();
                Settle(readsInFlight);
                Report($"round {round + 1} after {name}", Sample());
            }
            Selects();
            Settle(readsInFlight);
            Report($"round {round + 1} at rest", Sample());
        }

        var ended = Sample();
        Report("end", ended);
        Assert.True(Index.Queries.GetStatus().State == LoadOrderState.Ready);
        Assert.True(WalBytes() <= SmallBound, $"The write-ahead log stands at {Mb(WalBytes())} MiB after {Rounds} rounds.");
        var held = readsInFlight ? ended.Keys.Union(started.Keys).Except(WorkingMemory) : ended.Keys.Union(started.Keys);
        foreach (var tag in held)
        {
            var (before, after) = (started.GetValueOrDefault(tag), ended.GetValueOrDefault(tag));
            Assert.True(after - before <= (readsInFlight ? UnevictableBound : SmallBound), $"duckdb_memory() tag {tag} grew from {Mb(before)} to {Mb(after)} MiB over {Rounds} rounds.");
        }
    }

    private void Settle(bool readsInFlight)
    {
        Waits.Reached(() => Index.Status is { State: not LoadOrderState.Reconciling, Validating: false }, "the record index at rest");
        if (!readsInFlight) IndexFiles.Checkpointed(Modlist.InstanceRoot);
    }

    private long WalBytes() => new FileInfo(IndexFiles.In(Modlist.InstanceRoot) + ".wal") is { Exists: true } wal ? wal.Length : 0;

    /// <summary>Reads that overlap with no gap: each opens before the one before it ends, so one is always in flight.</summary>
    private sealed class ReadsInFlight : IDisposable
    {
        private const string Select = "SELECT form_key, editor_id FROM records WHERE record_type = 'NPC_' LIMIT 20000";
        private const int RowsTakenBeforeTheNextOpens = 500;

        private readonly CancellationTokenSource _stop = new();
        private readonly Task _chain;

        internal ReadsInFlight(IQueries queries)
        {
            var first = queries.SelectRows(Select, CancellationToken.None).Value();
            _chain = Task.Run(() =>
            {
                var current = first;
                while (!_stop.IsCancellationRequested)
                {
                    if (!queries.SelectRows(Select, CancellationToken.None).Holds(out var next, out _))
                    {
                        Thread.Sleep(TimeSpan.FromMilliseconds(10));
                        continue;
                    }
                    current.Dispose();
                    current = next;
                    _ = current.Rows().Take(RowsTakenBeforeTheNextOpens).Count();
                }
                current.Dispose();
            });
        }

        public void Dispose()
        {
            _stop.Cancel();
            _chain.GetAwaiter().GetResult();
            _stop.Dispose();
        }
    }

    private Dictionary<string, long> Sample() =>
        IndexFiles.Rows(Modlist.InstanceRoot, "SELECT tag, memory_usage_bytes FROM duckdb_memory()")
            .ToDictionary(row => row[0], row => long.Parse(row[1], CultureInfo.InvariantCulture));

    private static string Mb(long bytes) => (bytes / 1048576.0).ToString("F1", CultureInfo.InvariantCulture);

    private void Report(string when, Dictionary<string, long> memory) =>
        Console.WriteLine($"BUDGET Soak memory {when}: total {Mb(memory.Values.Sum())} MiB, wal {Mb(WalBytes())} MiB; " +
            string.Join(", ", memory.Where(tag => tag.Value > 0).OrderByDescending(tag => tag.Value).Select(tag => $"{tag.Key} {Mb(tag.Value)}")));

    private void Selects()
    {
        var plugin = Modlist.BigSourcePlugin;
        string[] statements =
        [
            "SELECT form_key FROM records WHERE editor_id LIKE '%Quest%' LIMIT 500",
            $"SELECT form_key, body FROM records WHERE plugin = '{plugin.Name}' LIMIT 2000",
            "SELECT record_type, count(*) AS n FROM records GROUP BY record_type",
            "SELECT form_key FROM records ORDER BY editor_id LIMIT 100",
        ];
        foreach (var sql in statements)
        {
            using var rows = Index.Queries.SelectRows(sql, CancellationToken.None).Value();
            Assert.All(rows.Rows(), row => row.Value());
        }
        Assert.Equal(20, Index.Queries.GetRecords(types: null, plugin: null, search: "Quest", limit: 20, offset: 0).Value().Items.Count);
        Assert.NotNull(Index.Queries.GetCompare(Modlist.OverriddenRecord, null).Value());
    }

    private void Writes() => EditedThenRestored(Modlist.TheManyDocuments.Take(DocumentsWritten).ToList(), edit: true);

    private void Deletes() => EditedThenRestored(Modlist.TheManyDocuments.Skip(DocumentsWritten).Take(DocumentsDeleted).ToList(), edit: false);

    private void EditedThenRestored(IReadOnlyList<string> formKeys, bool edit)
    {
        var plugin = Modlist.BigSourcePlugin;
        var documents = formKeys.Select(formKey => Index.DocumentOf(formKey, plugin.Key)).ToList();
        var files = documents.Select(plugin.SourceFileOf).ToList();
        var originals = files.Select(File.ReadAllBytes).ToList();
        try
        {
            if (edit)
            {
                foreach (var document in documents)
                    plugin.HandEdit(document, $"\"{document.EditorId}\"", "\"Edited\"");
            }
            else
            {
                foreach (var file in files) File.Delete(file);
            }
            Held(plugin.Key, files);
        }
        finally
        {
            for (var i = 0; i < files.Count; i++) File.WriteAllBytes(files[i], originals[i]);
            Held(plugin.Key, files);
        }
    }

    private void Held(PluginAddress plugin, IReadOnlyList<string> files)
    {
        Assert.Null(Index.Queries.Hold([new HandedPlugin(plugin, files, [])], CancellationToken.None).GetAwaiter().GetResult());
        Waits.Reached(() => !Index.Status.Validating, "the record index's read of the write");
    }

    private void Compiles()
    {
        foreach (var small in Modlist.SmallBinaryPlugins.Take(20)) PluginBinaries.Touch(small.Path);
        Index.SignalChange();
        Waits.Reached(() => Index.Status.State != LoadOrderState.Reconciling, "the check of the compile");
    }

    private void Uninstalls()
    {
        var kept = Modlist.LoadOrder.Where((_, rank) => !UninstalledRanks.Contains(rank)).ToArray();
        realSize.Receive(SnapshotPlugins.Snapshot(Modlist.DataFolder, Modlist.InstanceRoot, GameRelease.Fallout4, kept));
        Assert.Equal(Modlist.LoadOrder.Count - UninstalledRanks.Length, Count("SELECT count(*) FROM registrations"));
        realSize.Receive(Modlist.Snapshot());
        Assert.Equal(Modlist.LoadOrder.Count, Count("SELECT count(*) FROM registrations"));
    }

    private long Count(string sql) =>
        long.Parse(IndexFiles.Rows(Modlist.InstanceRoot, sql).Single().Single(), CultureInfo.InvariantCulture);
}
