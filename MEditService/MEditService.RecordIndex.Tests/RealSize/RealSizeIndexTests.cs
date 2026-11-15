using System.Globalization;
using System.Text.Json.Nodes;
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
    private static readonly TimeSpan LitRsLaunch = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LitRsIndexWorkForOneDeletedRecord = TimeSpan.FromSeconds(0.4);
    private static readonly TimeSpan OneFactsRead = TimeSpan.FromSeconds(0.01);
    private static readonly TimeSpan OneFilesRead = TimeSpan.FromSeconds(0.1);
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

    private DocumentsPutBack CheckpointOfEarlierWritesLanded()
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
        Index.Holder.SourceWritten([written]);
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

    private DocumentsPutBack Restoring(string path, Func<bool> restored) => Restoring([path], restored);

    private DocumentsPutBack Restoring(IReadOnlyList<string> paths, Func<bool> restored) =>
        new([.. paths.Select(path => (path, File.ReadAllText(path)))], realSize, restored);

    private sealed class DocumentsPutBack(IReadOnlyList<(string Path, string Text)> documents, RealSizeIndex realSize, Func<bool> restored) : IDisposable
    {
        public void Dispose() => realSize.Restore(() =>
        {
            foreach (var (path, text) in documents) File.WriteAllText(path, text);
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
    public void TheMastersBigCell_ListsItsReferencesWithinOneSecond()
    {
        var (queries, modlist) = (Index.Queries, Modlist);
        CellChildRecords? listed = null;

        Budgets.Ran(OneGesture, () => listed = queries.GetCellChildRecords(modlist.Master.Key, modlist.MastersBigCell).Value(), "Expanding the master's big cell", Runs);
        Assert.Equal(RealSizeModlist.ReferencesInTheBigCell, listed?.Temporary.Count);
    }
}
