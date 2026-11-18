using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.RealSize;

[Collection(RealSizeCollection.Name)]
public sealed class RealSizeIndexTests(RealSizeIndex realSize)
{
    private static readonly TimeSpan OneGesture = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan OneKeystroke = TimeSpan.FromSeconds(0.25);
    private static readonly TimeSpan LitRsLaunch = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LitRsIndexWorkForOneDeletedRecord = TimeSpan.FromSeconds(0.4);
    private static readonly TimeSpan OneFactsRead = TimeSpan.FromSeconds(0.01);
    private static readonly TimeSpan OneFilesRead = TimeSpan.FromSeconds(0.1);
    private static readonly TimeSpan OneKeyedRead = TimeSpan.FromSeconds(0.1);
    private static readonly TimeSpan HalfAGesture = TimeSpan.FromSeconds(0.5);
    private static readonly TimeSpan OneAnswerOfEveryMastersRecord = TimeSpan.FromSeconds(1.5);
    private static readonly TimeSpan OneRecordsRead = TimeSpan.FromSeconds(0.25);
    private static readonly TimeSpan OneRecordsComparison = TimeSpan.FromSeconds(0.5);
    private const int Runs = 5;
    private const int Launches = 3;

    private OpenedIndex Index => realSize.Index;

    private RealSizeModlist Modlist => realSize.Modlist;

    [RealSizeFact]
    public void TheGeneratedModlist_IsIndexedAtLitRsSize()
    {
        Assert.Equal(LoadOrderState.Ready, Index.Status.State);
        Assert.Equal(RealSizeModlist.Plugins, Count("SELECT count(*) FROM registrations"));
        Assert.Equal(RealSizeModlist.SourceTreePlugins, Count("SELECT count(*) FROM mirror.plugin_derivation WHERE derived_from = 'SourceTree'"));
        Assert.InRange(Count("SELECT count(*) FROM mirror.records"), 3_000_000, 3_200_000);
        Assert.InRange(Count("SELECT count(*) FROM mirror.form_references"), 17_000_000, 19_000_000);
        Assert.InRange(Count("SELECT count(*) FROM mirror.holdings"), 2_800_000, 3_000_000);
        Assert.InRange(Count("SELECT sum(length(body)) FROM mirror.records"), 5_500_000_000, 6_500_000_000);
    }

    private long Count(string sql) =>
        long.Parse(IndexFiles.Rows(Modlist.InstanceRoot, sql).Single().Single(), CultureInfo.InvariantCulture);

    [RealSizeFact]
    public void OnePluginsFacts_AreReadWithinAFewMilliseconds_AndUnderARecordFilterInAThirdOfEveryPluginsTime()
    {
        PluginAddress[] one = [Modlist.LoadOrder[^1].Key];
        PluginAddress[] big = [Modlist.BigSourcePlugin.Key];
        Assert.Single(Index.Queries.GetPlugins(one).Value());
        Assert.Equal(RealSizeModlist.Plugins, Index.Queries.GetPlugins().Value().Count);

        var oneTook = Budgets.Fastest(() => Index.Queries.GetPlugins(one).Value(), Runs);
        var everyTook = Budgets.Fastest(() => Index.Queries.GetPlugins().Value(), Runs);
        Index.SetFilter("SELECT form_key FROM npc_", "plugin-facts.sql");
        TimeSpan oneFilteredTook, bigFilteredTook, everyFilteredTook;
        try
        {
            oneFilteredTook = Budgets.Fastest(() => Index.Queries.GetPlugins(one).Value(), Runs);
            bigFilteredTook = Budgets.Fastest(() => Index.Queries.GetPlugins(big).Value(), Runs);
            everyFilteredTook = Budgets.Fastest(() => Index.Queries.GetPlugins().Value(), Runs);
        }
        finally
        {
            Index.Queries.ClearFilter();
        }

        Console.WriteLine($"BUDGET One plugin's facts: {oneTook.TotalMilliseconds:F2} ms, every plugin's: {everyTook.TotalMilliseconds:F2} ms; " +
            $"with a record filter: {oneFilteredTook.TotalMilliseconds:F2} ms, the big source plugin's {bigFilteredTook.TotalMilliseconds:F2} ms, every plugin's {everyFilteredTook.TotalMilliseconds:F2} ms");
        Assert.True(oneTook <= OneFactsRead * 3, $"One plugin's facts took {oneTook.TotalMilliseconds:F1} ms.");
        Assert.True(oneFilteredTook * 3 < everyFilteredTook, $"One plugin's facts under a record filter took {oneFilteredTook.TotalMilliseconds:F1} ms.");
        Assert.True(bigFilteredTook < everyFilteredTook);
    }

    [RealSizeFact]
    public void ALaunchWithNothingChanged_IsReadyWithinLitRsTenSeconds()
    {
        _ = Index;

        Budgets.Ran(LitRsLaunch, realSize.Relaunch, $"A launch of {RealSizeModlist.Plugins} plugins with nothing changed", Launches);
        Assert.Equal(LoadOrderState.Ready, Index.Status.State);
    }

    [RealSizeFact]
    public void APluginWhoseWholeTreeIsUncommitted_IsIndexedWithinTwoSecondsOfArriving()
    {
        var (index, modlist) = (Index, Modlist);
        try
        {
            var version = index.Holder.Apply(modlist.Snapshot(modlist.UncommittedPlugin));

            Budgets.Reached(
                TimeSpan.FromSeconds(2),
                () => index.Status.Version >= version && index.Status.State == LoadOrderState.Ready,
                $"Indexing {modlist.UncommittedPlugin.Name}");
            Assert.Equal(WorkingTreeState.Added, index.RowOf(modlist.AReferenceInTheUncommittedCell, modlist.UncommittedPlugin.Key)?.WorkingTreeState);
        }
        finally
        {
            realSize.Restore(() => realSize.Receive(modlist.Snapshot()), () => index.Status.State == LoadOrderState.Ready);
        }
    }

    [RealSizeFact]
    public void AnEditToOneReferenceInABigCell_ReachesReadsWithinOneSecond()
    {
        var reference = Index.DocumentOf(Modlist.AReferenceInTheBigCell, Modlist.BigSourcePlugin.Key);
        using var restored = Restoring(Modlist.BigSourcePlugin.SourceFileOf(reference), () => !ReferenceRead().Contains("\"Edited\"", StringComparison.Ordinal));
        Modlist.BigSourcePlugin.HandEdit(reference, $"\"{reference.EditorId}\"", "\"Edited\"");

        Index.SignalChange();

        Budgets.Reached(OneGesture, () => ReferenceRead().Contains("\"Edited\"", StringComparison.Ordinal), "An edit to one reference reaching reads");
    }

    private string ReferenceRead() =>
        Index.Queries.GetRenderedDocument(Modlist.BigSourcePlugin.Key, Modlist.AReferenceInTheBigCell).Value()?.Text ?? "";

    [RealSizeFact]
    public void ACheckAfterAThousandSeparateDocumentsChange_ReachesReadsWithinOneSecond()
    {
        var plugin = Modlist.BigSourcePlugin;
        var identities = Modlist.TheManyDocuments.Select((formKey, d) => new RecordIdentity(formKey, "KYWD", $"Document{d:D4}")).ToList();
        using var restored = Restoring([.. identities.Select(plugin.SourceFileOf)], () => Edited() == 0);
        foreach (var identity in identities)
            plugin.HandEdit(identity, $"\"{identity.EditorId}\"", "\"Edited\"");

        Index.SignalChange();

        Budgets.Reached(OneGesture, () => Edited() == RealSizeModlist.ManyDocuments, "A check after 1,000 documents changed reaching reads");
    }

    private int Edited() =>
        Index.Queries.GetRecords(types: null, Modlist.BigSourcePlugin.Key, search: "Edited", limit: int.MaxValue, offset: 0)
            .Value().Items.Count(row => row.EditorId == "Edited");

    [RealSizeFact]
    public void AThousandReferencesTakenOutOfABigCellsDocument_ReachReadsWithinOneSecond()
    {
        var path = BigCellsDocument();
        using var restored = Restoring(path, () => CheckEnded() && ReferencesListed() == RealSizeModlist.ReferencesInTheBigCell);
        var cell = JsonNode.Parse(File.ReadAllText(path)).Require().AsObject();
        var temporary = cell["Temporary"].Require().AsArray();
        for (var r = 0; r < 1_000; r++) temporary.RemoveAt(0);
        File.WriteAllText(path, RecordTextCodec.RoundTrip(cell.ToJsonString(), GameRelease.Fallout4, "cell"));

        Index.SignalChange();

        Budgets.Reached(OneGesture, () => CheckEnded() && ReferencesListed() == RealSizeModlist.ReferencesInTheBigCell - 1_000, "Taking 1,000 references out of a big cell reaching reads");
    }

    [RealSizeFact]
    public void ABigCellsDocumentDeleted_ReachesReadsWithinOneSecond()
    {
        var path = BigCellsDocument();
        using var restored = Restoring(path, () => CheckEnded() && ReferencesListed() == RealSizeModlist.ReferencesInTheBigCell);
        File.Delete(path);

        Index.SignalChange();

        Budgets.Reached(OneGesture, () => CheckEnded() && ReferencesListed() == 0, "Deleting a big cell's document reaching reads");
        Assert.Null(Index.CopyIn(Modlist.BigCell, Modlist.BigSourcePlugin.Key));
    }

    [RealSizeFact]
    public void ARecordItsWriterDeleted_IsReadWithinLitRsIndexWorkForOneDeletedRecord()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[0]);
        var path = plugin.SourceFileOf(Index.DocumentOf(formKey, plugin.Key));
        using var landed = CheckpointOfEarlierWritesLanded();
        using var restored = Restoring(path, () => CheckEnded() && Index.CopyIn(formKey, plugin.Key) is not null);
        File.Delete(path);

        ReadAlone(LitRsIndexWorkForOneDeletedRecord, () => WrittenAndRead(new PluginChange(plugin.Key, [path])), "Reading a record its writer deleted");
        Assert.Null(Index.CopyIn(formKey, plugin.Key));
    }

    private void ReadAlone(TimeSpan budget, Action gesture, string what)
    {
        var (named, whole) = (realSize.Source.NamedReads, realSize.Source.WholeTreeReads);
        Budgets.Ran(budget, gesture, what);
        Assert.Equal((named + 1, whole), (realSize.Source.NamedReads, realSize.Source.WholeTreeReads));
    }

    private FilesPutBack CheckpointOfEarlierWritesLanded()
    {
        var plugin = Modlist.BigSourcePlugin;
        var path = plugin.SourceFileOf(Index.DocumentOf(Modlist.TheManyDocuments[^1], plugin.Key));
        var putBack = Restoring(path, CheckEnded);
        File.AppendAllText(path, "\n");
        WrittenAndRead(new PluginChange(plugin.Key, [path]));
        IndexFiles.Checkpointed(Modlist.InstanceRoot);
        return putBack;
    }

    private void WrittenAndRead(PluginChange written)
    {
        Held(written);
        Waits.Reached(() => !Index.Status.Validating, "the record index's read of the write");
    }

    [RealSizeFact]
    public void TheWatchersEchoOfAWrite_IsReadWithinOneFilesRead()
    {
        var plugin = Modlist.BigSourcePlugin;
        var path = plugin.SourceFileOf(Index.DocumentOf(Modlist.TheManyDocuments[1], plugin.Key));
        using var restored = Restoring(path, CheckEnded);
        File.AppendAllText(path, "\n");
        WrittenAndRead(new PluginChange(plugin.Key, [path]));

        ReadAlone(OneFilesRead, () =>
        {
            Index.SignalChange([new PluginChange(plugin.Key, [path])]);
            Waits.Reached(() => !Index.Status.Validating, "the record index's read of the echo");
        }, "Reading the watcher's echo of a write");
    }

    [RealSizeFact]
    public void AnEditMadeDuringACheckThatReadsManyPlugins_ReturnsWithinOneGesture()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[2]);
        var record = Index.DocumentOf(formKey, plugin.Key);
        var path = plugin.SourceFileOf(record);
        var rewritten = Modlist.SmallBinaryPlugins;
        using var restored = Restoring([path, .. rewritten.Select(small => small.Path)],
            () => CheckEnded() && !Index.Status.Validating && Index.RowOf(formKey, plugin.Key)?.EditorId == record.EditorId);
        foreach (var small in rewritten) PluginBinaries.Touch(small.Path);
        var check = Index.Queries.Hold(null, CancellationToken.None);
        plugin.HandEdit(record, $"\"{record.EditorId}\"", "\"Edited\"");

        var took = Budgets.Fastest(() => Held(new PluginChange(plugin.Key, [path])));

        Console.WriteLine($"BUDGET An edit made during a check that reads {rewritten.Count} plugins: {took.TotalSeconds:F2} s");
        Assert.True(took <= OneGesture, $"The edit took {took.TotalSeconds:F2} s, past its budget of {OneGesture.TotalSeconds:F1} s.");
        Assert.False(check.IsCompleted, "The check ended before the edit returned.");
        Assert.Equal("Edited", Index.RowOf(formKey, plugin.Key)?.EditorId);
        Assert.Null(check.GetAwaiter().GetResult());
    }

    [RealSizeFact]
    public void OneKeystrokeInABigPluginsDocument_IsHeldWithinOneKeystroke()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[4]);
        var record = Index.DocumentOf(formKey, plugin.Key);
        var (path, text) = (plugin.SourceFileOf(record), plugin.SourceTextOf(record));
        var typed = 0;
        try
        {
            Budgets.Ran(OneKeystroke, () =>
            {
                var editorId = $"Typed{++typed}";
                var typedText = text.Replace($"\"{record.EditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal);
                Index.Unsaved.Typed(new DocumentChange(path, typedText));
                Assert.Null(Index.Queries.Hold([new HandedPlugin(plugin.Key, [path], [])], CancellationToken.None).GetAwaiter().GetResult());
                Assert.Equal(editorId, Index.RowOf(formKey, plugin.Key)?.EditorId);
            }, "One keystroke in a big plugin's document held", Runs);
        }
        finally
        {
            realSize.Restore(() =>
            {
                Index.Unsaved.Closed(path);
                Assert.Null(Index.Queries.Hold([new HandedPlugin(plugin.Key, [path], [])], CancellationToken.None).GetAwaiter().GetResult());
            }, () =>
            {
                return CheckEnded() && !Index.Status.Validating && Index.RowOf(formKey, plugin.Key)?.EditorId == record.EditorId;
            });
        }
    }

    [RealSizeFact]
    public void AViewsReads_AnswerWithinTheirBudgets_WhileARecordFilterLands()
    {
        WarmedReads();
        var filter = Task.Run(() => Index.Queries.SetFilter("SELECT form_key FROM records WHERE hash(body) = 0", "slow.sql"));
        try
        {
            Answering("while a record filter lands", filter);
            Assert.Null(filter.GetAwaiter().GetResult());
        }
        finally
        {
            filter.GetAwaiter().GetResult();
            Index.Queries.ClearFilter();
        }
    }

    [RealSizeFact]
    public void AViewsReads_AnswerWithinTheirBudgets_WhileACheckOfTheDiskRuns()
    {
        var rewritten = Modlist.SmallBinaryPlugins;
        using var restored = Restoring([.. rewritten.Select(small => small.Path)], () => CheckEnded() && !Index.Status.Validating);
        foreach (var small in rewritten) PluginBinaries.Touch(small.Path);
        WarmedReads();

        var check = Index.Queries.Hold(null, CancellationToken.None);

        Answering($"while a check of the disk reads {rewritten.Count} plugins", check);
        Assert.Null(check.GetAwaiter().GetResult());
    }

    [RealSizeFact]
    public void AViewsReads_AnswerWithinTheirBudgets_WhileALaunchReconcilesEveryPlugin()
    {
        var launch = realSize.Relaunching();
        try
        {
            WarmedReads();
            Answering($"while a launch reconciles {RealSizeModlist.Plugins} plugins", launch);
        }
        finally
        {
            realSize.Restore(() => launch.GetAwaiter().GetResult(), () => Index.Status.State == LoadOrderState.Ready);
        }
    }

    private (TimeSpan Budget, Action Read, string What)[] Reads =>
    [
        (OneFactsRead, () => _ = Index.Status, "The record index's status"),
        (OneFactsRead, () => _ = Index.Sequence, "The record index's sequence"),
        (OneKeystroke, () => Index.Queries.GetRecords(types: null, plugin: null, search: "Quest", limit: 20, offset: 0).Value(), "Searching every plugin's records"),
        (OneKeystroke, () => Assert.NotEmpty(Index.Queries.Selected($"SELECT editor_id FROM records WHERE form_key = '{Modlist.OverriddenRecord}'")), "A script's SELECT"),
    ];

    private void WarmedReads()
    {
        foreach (var (_, read, _) in Reads) read();
    }

    private void Answering(string whileWorking, Task work)
    {
        Thread.Sleep(HalfAGesture);

        foreach (var (budget, read, what) in Reads) Budgets.Ran(budget, read, $"{what} {whileWorking}");

        Assert.False(work.IsCompleted, $"The work ended before the reads {whileWorking} were timed.");
    }

    private void Held(PluginChange written) =>
        Assert.Null(Index.Queries.Hold([new HandedPlugin(written.Plugin, written.Files, [])], CancellationToken.None).GetAwaiter().GetResult());

    [RealSizeFact]
    public void ARecordItsWriterCreated_IsReadWithinOneGesture()
    {
        var plugin = Modlist.BigSourcePlugin;
        var (formKey, model) = ($"FFF000:{plugin.Name}", Index.DocumentOf(Modlist.TheManyDocuments[0], plugin.Key));
        var body = plugin.SourceTextOf(model)
            .Replace(model.FormKey, formKey, StringComparison.Ordinal)
            .Replace($"\"{model.EditorId}\"", "\"Created\"", StringComparison.Ordinal);
        var repository = SourceMods.RepositoryOf(plugin);
        var created = repository.ChangesToPut(plugin.Key, new SourceDocument(formKey, model.RecordType, "Created", body)).Value()
            .Under(repository.SourceFolder).Documents.Single();
        using var landed = CheckpointOfEarlierWritesLanded();
        using var restored = new CreatedPutBack(created.Path, realSize, () => CheckEnded() && Index.CopyIn(formKey, plugin.Key) is null);
        File.WriteAllText(created.Path, created.Text);

        ReadAlone(OneGesture, () => WrittenAndRead(new PluginChange(plugin.Key, [created.Path])), "Reading a record its writer created");
        Assert.Equal("Created", Index.RowOf(formKey, plugin.Key)?.EditorId);
    }

    private sealed class CreatedPutBack(string path, RealSizeIndex realSize, Func<bool> restored) : IDisposable
    {
        public void Dispose() => realSize.Restore(() =>
        {
            File.Delete(path);
            realSize.Index.SignalChange();
        }, restored);
    }

    private string BigCellsDocument() => Modlist.BigSourcePlugin.SourceFileOf(Index.DocumentOf(Modlist.BigCell, Modlist.BigSourcePlugin.Key));

    private bool CheckEnded() => Index.Status.State != LoadOrderState.Reconciling;

    private int ReferencesListed() =>
        Index.Queries.GetCellChildRecords(Modlist.BigSourcePlugin.Key, Modlist.BigCell).Value().Temporary.Count;

    private FilesPutBack Restoring(string path, Func<bool> restored) => Restoring([path], restored);

    private FilesPutBack Restoring(IReadOnlyList<string> paths, Func<bool> restored) =>
        new([.. paths.Select(path => (path, File.ReadAllBytes(path)))], realSize, restored);

    private sealed class FilesPutBack(IReadOnlyList<(string Path, byte[] Bytes)> files, RealSizeIndex realSize, Func<bool> restored) : IDisposable
    {
        public void Dispose() => realSize.Restore(() =>
        {
            foreach (var (path, bytes) in files) File.WriteAllBytes(path, bytes);
            realSize.Index.SignalChange();
        }, restored);
    }

    [RealSizeFact]
    public void TheMastersBigCell_OpensWithinOneSecond()
    {
        var (queries, modlist) = (Index.Queries, Modlist);
        RenderedDocument? opened = null;

        Budgets.Ran(OneGesture, () => opened = queries.GetRenderedDocument(modlist.Master.Key, modlist.MastersBigCell).Value(), "Opening the master's big cell", Runs);
        Assert.Contains("\"MastersBigCell\"", opened?.Text, StringComparison.Ordinal);
    }

    [RealSizeFact]
    public void ASlowReadItsCallerLeft_StopsWithinThreeKeystrokes()
    {
        const string slow = "SELECT max(hash(a.form_key || b.form_key)) AS v FROM records a, (SELECT form_key FROM records LIMIT 20000) b";
        using var left = new CancellationTokenSource();
        var read = Task.Run(() => Index.Queries.SelectRows(slow, left.Token));
        Thread.Sleep(OneGesture);

        var abandoned = Stopwatch.StartNew();
        left.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => read.GetAwaiter().GetResult());

        Console.WriteLine($"BUDGET The record index working on after the extension cancelled a slow read: {abandoned.Elapsed.TotalSeconds:F2} s");
        Assert.True(abandoned.Elapsed <= OneKeystroke * 3, $"The read went on for {abandoned.Elapsed.TotalSeconds:F2} s after its caller left.");
    }

    [RealSizeFact]
    public void TheMastersBigCell_ListsItsReferencesWithinOneSecond()
    {
        var (queries, modlist) = (Index.Queries, Modlist);
        CellChildRecords? listed = null;

        Budgets.Ran(OneGesture, () => listed = queries.GetCellChildRecords(modlist.Master.Key, modlist.MastersBigCell).Value(), "Expanding the master's big cell", Runs);
        Assert.Equal(RealSizeModlist.ReferencesInTheBigCell, listed?.Temporary.Count);
    }

    [RealSizeFact]
    public void ASearchAsTheUserTypes_AnswersWithinAQuarterOfAGesture()
    {
        PagedResult<RecordSummary>? found = null;

        Budgets.Ran(OneKeystroke, () => found = Index.Queries.GetRecords(types: null, plugin: null, search: "Quest", limit: 20, offset: 0).Value(), "Searching every plugin's records for \"Quest\"", Runs);
        Assert.Equal(20, found?.Items.Count);
    }

    [RealSizeFact]
    public void TheMastersWorldspaceBlocks_ListWithinOneSecond()
    {
        var master = Modlist.Master.Key;
        var world = Index.Queries.GetWorldspaces(master).Value().First(w => w.HasChildren);
        WorldspaceBlocks? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetWorldspaceBlocks(master, world.FormKey).Value(), "Expanding the master's worldspace", Runs);
        Assert.NotEmpty(listed?.Blocks ?? []);
    }

    [RealSizeFact]
    public void TheMastersInteriorCells_ListWithinOneSecond()
    {
        IReadOnlyList<InteriorCellBlock>? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetInteriorCells(Modlist.Master.Key).Value(), "Expanding the master's interior cells", Runs);
        Assert.NotEmpty(listed ?? []);
    }

    [RealSizeFact]
    public void AQuestsTopics_ListWithinAQuarterOfAGesture()
    {
        var master = Modlist.Master.Key;
        var quest = Index.Queries.GetRecords(["qust"], master, search: null, limit: 1, offset: 0).Value().Items.Single();
        IReadOnlyList<ContainerChildSummary>? listed = null;

        Budgets.Ran(OneKeystroke, () => listed = Index.Queries.GetContainerChildren(master, quest.FormKey).Value(), "Expanding a quest's topics", Runs);
        Assert.NotEmpty(listed ?? []);
    }

    [RealSizeFact]
    public void OneRecordsRead_TakesAQuarterOfAGesture()
    {
        var (queries, modlist) = (Index.Queries, Modlist);
        var copy = new RecordCopy(modlist.OverriddenRecord, modlist.LoadOrder[1].Key);
        CompareRecordsAnswer? read = null;

        Budgets.Ran(OneRecordsRead, () => read = queries.GetCompareRecords([copy]).Value(), "Reading one record", Runs);
        Assert.Single(read?.Compare?.Overrides ?? []);
    }

    [RealSizeFact]
    public void ARecordsComparisonAcrossItsDeepestStack_TakesHalfAGesture()
    {
        var (queries, modlist) = (Index.Queries, Modlist);
        CompareResult? compared = null;

        Budgets.Ran(OneRecordsComparison, () => compared = queries.GetCompare(modlist.OverriddenRecord, null).Value(), "Comparing a record across its stack", Runs);
        Assert.Equal(modlist.LoadOrder.Take(RealSizeModlist.PluginsOverridingOneRecord + 1).Count(plugin => plugin.Enabled), compared?.Overrides.Count);
    }

    [RealSizeFact]
    public void TheFilePathsOfEveryPlugin_ListWithinOneGesture()
    {
        IReadOnlyList<PluginFilePaths>? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetFilePaths(null).Value(), "Listing the file paths of every plugin", Runs);
        Assert.Equal(RealSizeModlist.SourceTreePlugins, listed?.Count);
        Assert.Contains(listed ?? [], plugin => plugin.Paths.Count > 0);
    }

    [RealSizeFact]
    public void TheFilePathsOfOnePlugin_ListWithinAQuarterOfAGesture()
    {
        IReadOnlyList<PluginFilePaths>? listed = null;

        Budgets.Ran(OneKeystroke, () => listed = Index.Queries.GetFilePaths(Modlist.BigSourcePlugin.Key).Value(), "Listing the file paths of one plugin", Runs);
        Assert.NotEmpty(Assert.Single(listed ?? []).Paths);
    }

    [RealSizeFact]
    public void TheReferencesToAFilePath_ListWithinAQuarterOfAGesture()
    {
        MemberReferences? listed = null;

        Budgets.Ran(OneKeystroke, () => listed = Index.Queries.GetFileReferences(RealSizeModlist.AFileTheBigSourcePluginNames).Value(), "Listing the references to a file path", Runs);
        Assert.NotEmpty(listed?.Copies ?? []);
    }

    [RealSizeFact]
    public void TheReferencesToAScript_ListWithinAQuarterOfAGesture()
    {
        MemberReferences? listed = null;

        Budgets.Ran(OneKeystroke, () => listed = Index.Queries.GetScriptReferences(RealSizeModlist.AttachedScript).Value(), "Listing the references to a script", Runs);
        Assert.NotEmpty(listed?.Copies ?? []);
    }

    [RealSizeFact]
    public void TheMastersRecordTypes_AreCountedWithinOneGesture()
    {
        IReadOnlyList<PluginRecordTypeCount>? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetPluginRecordTypes(Modlist.Master.Key).Value(), "Expanding the master", Runs);
        Assert.Contains(listed ?? [], type => type.Type == "npc_");
    }

    [RealSizeFact]
    public void TheMastersNpcs_ListWithinOneGesture()
    {
        PagedResult<RecordSummary>? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetRecords(["npc_"], Modlist.Master.Key, search: null, limit: int.MaxValue, offset: 0).Value(), "Expanding the master's NPCs", Runs);
        Assert.NotEmpty(listed?.Items ?? []);
    }

    [RealSizeFact]
    public void TheMastersWorldspaces_ListWithinHalfAGesture()
    {
        IReadOnlyList<WorldspaceSummary>? listed = null;

        Budgets.Ran(HalfAGesture, () => listed = Index.Queries.GetWorldspaces(Modlist.Master.Key).Value(), "Expanding the master's worldspaces", Runs);
        Assert.Equal("World000", Assert.Single(listed ?? []).EditorId);
    }

    [RealSizeFact]
    public void TheWorkingTreeStatesBeneathTheBigSourcePlugin_ReadWithinAQuarterOfAGesture()
    {
        WorkingTreeStatesBeneath? read = null;

        Budgets.Ran(OneKeystroke, () => read = Index.Queries.GetWorkingTreeStatesBeneath(Modlist.BigSourcePlugin.Key).Value(), "Reading the states beneath the big source plugin", Runs);
        Assert.Equal((0, 0, 0), (read?.Plugin.Count, read?.RecordTypes.Count, read?.Records.Count));
    }

    [RealSizeFact]
    public void TheTypesTheMastersBigCellCanHold_ReadWithinAQuarterOfAGesture()
    {
        IReadOnlyList<RecordTypeChoice>? read = null;

        Budgets.Ran(OneKeystroke, () => read = Index.Queries.GetChildRecordTypes(Modlist.Master.Key, Modlist.MastersBigCell).Value(), "Reading the types a big cell can hold", Runs);
        Assert.Contains(read ?? [], type => type.Type == "refr");
    }

    [RealSizeFact]
    public void ARecordsDocument_IsFoundWithinAQuarterOfAGesture()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[6]);
        CopyDocument? found = null;

        Budgets.Ran(OneKeystroke, () => found = Index.Queries.GetCopyDocument(plugin.Key, formKey).Value(), "Finding a record's document", Runs);
        Assert.Equal(new CopyDocument(CopyDocumentKind.OwnFile, plugin.SourceFileOf(Index.DocumentOf(formKey, plugin.Key))), found);
    }

    [RealSizeFact]
    public void TheMastersBigCellsRenderedDocument_IsFoundWithinAQuarterOfAGesture()
    {
        CopyDocument? found = null;

        Budgets.Ran(OneKeystroke, () => found = Index.Queries.GetCopyDocument(Modlist.Master.Key, Modlist.MastersBigCell).Value(), "Finding a big cell's rendered document", Runs);
        Assert.Equal(CopyDocumentKind.Rendered, found?.Kind);
    }

    [RealSizeFact]
    public void ARecordsOwner_IsReadWithinAQuarterOfAGesture()
    {
        IReadOnlyList<PluginAddress>? owners = null;

        Budgets.Ran(OneKeystroke, () => owners = Index.Queries.GetRecordOwners(Modlist.OverriddenRecord).Value(), "Reading a record's owner", Runs);
        Assert.Single(owners ?? []);
    }

    [RealSizeFact]
    public void TheReferencesToARecord_ListWithinOneGesture()
    {
        IReadOnlyList<ReferenceResult>? listed = null;

        Budgets.Ran(OneGesture, () => listed = Index.Queries.GetReferencesInActiveOrCompiledPlugins(Modlist.MastersBigCellsBase).Value(), "Listing the references to a record", Runs);
        Assert.Equal(RealSizeModlist.ReferencesInTheBigCell, listed?.Count);
    }

    [RealSizeFact]
    public void TheReferencesToARecord_ArePlacedWithinOneGesture()
    {
        PlacedReferences? placed = null;

        Budgets.Ran(OneGesture, () => placed = Index.Queries.GetPlacedReferences(Modlist.MastersBigCellsBase).Value(), "Placing the references to a record", Runs);
        Assert.NotEmpty(placed?.Copies ?? []);
    }

    [RealSizeFact]
    public void TheBigSourcePluginsProblems_ReadWithinOneGesture()
    {
        IReadOnlyList<PluginProblems>? read = null;

        Budgets.Ran(OneGesture, () => read = Index.Queries.GetProblems(Modlist.BigSourcePlugin.Key).Value(), "Reading the big source plugin's problems", Runs);
        Assert.Single(read ?? []);
    }

    [RealSizeFact]
    public void EveryPluginsProblems_ReadWithinOneGesture()
    {
        IReadOnlyList<PluginProblems>? read = null;

        Budgets.Ran(OneGesture, () => read = Index.Queries.GetProblems(null).Value(), "Reading every plugin's problems", Runs);
        Assert.Equal(RealSizeModlist.SourceTreePlugins, read?.Count);
    }

    [RealSizeFact]
    public void EveryPluginsDiagnoses_ReadWithinAQuarterOfAGesture()
    {
        IReadOnlyList<PluginDiagnosisReport>? read = null;

        Budgets.Ran(OneKeystroke, () => read = Index.Queries.GetLoadOrderDiagnoses().Value(), "Reading every plugin's diagnoses", Runs);
        Assert.Empty(read ?? [new PluginDiagnosisReport("", "", "unread")]);
    }

    [RealSizeFact]
    public void TheNamesInADocument_AreReadWithinAQuarterOfAGesture()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[3]);
        var record = Index.DocumentOf(formKey, plugin.Key);
        var (path, text) = (plugin.SourceFileOf(record), plugin.SourceTextOf(record));
        IReadOnlyList<DocumentName>? named = null;

        Budgets.Ran(OneKeystroke, () => named = Index.Queries.GetPluginSourceNames(path, text, text.IndexOf(formKey, StringComparison.Ordinal)).Value(), "Reading the name under the cursor", Runs);
        Assert.NotEmpty(named ?? []);
    }

    [RealSizeFact]
    public void TheReferencesToASmallPluginsName_ListWithinOneKeyedRead()
    {
        var small = Modlist.SmallBinaryPlugins.First(plugin => plugin.Enabled);
        IReadOnlyList<CopyNaming>? listed = null;

        Budgets.Ran(OneKeyedRead, () => listed = Index.Queries.GetPluginNameReferences(small.Name).Value(), "Listing the references to a small plugin's name", Runs);
        Assert.NotEmpty(listed ?? []);
    }

    [RealSizeFact]
    public void TheReferencesToTheMastersName_ListWithinOneAnswerOfEveryMastersRecord()
    {
        IReadOnlyList<CopyNaming>? listed = null;

        Budgets.Ran(OneAnswerOfEveryMastersRecord, () => listed = Index.Queries.GetPluginNameReferences(Modlist.Master.Name).Value(), "Listing the references to the master's name", Runs);
        Assert.NotEmpty(listed ?? []);
    }

    [RealSizeFact]
    public void AName_ResolvesWithinOneKeyedRead()
    {
        IReadOnlyList<NamedObject>? named = null;

        Budgets.Ran(OneKeyedRead, () => named = Index.Queries.ResolveNames([new NameQuery("Overridden")]).Value(), "Resolving a name", Runs);
        Assert.Equal(Modlist.OverriddenRecord, Assert.Single(named ?? []).FormKey);
    }

    [RealSizeFact]
    public void ARenamedScriptsReferences_AreReadWithinOneGesture()
    {
        var queries = Index.Queries;
        var placed = 0;

        Budgets.Ran(OneGesture, () =>
        {
            var references = queries.GetScriptReferences(RealSizeModlist.AttachedScript).Value();
            placed = references.Copies.Count(copy => queries.GetCopyDocument(copy.Plugin, new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId)).Value() is not null);
        }, "Reading a script's references for its rename", Runs);
        Assert.True(placed > 0);
    }
}
