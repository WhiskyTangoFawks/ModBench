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
    private static readonly TimeSpan LitRsIndexWorkForOneRecord = TimeSpan.FromSeconds(0.4);
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
    public void ARecordItsWriterDeleted_ReachesReadsWithinLitRsIndexWorkForOneRecord()
    {
        var (plugin, formKey) = (Modlist.BigSourcePlugin, Modlist.TheManyDocuments[0]);
        var path = plugin.SourceFileOf(Index.DocumentOf(formKey, plugin.Key));
        using var restored = Restoring(path, () => CheckEnded() && Index.CopyIn(formKey, plugin.Key) is not null);
        File.Delete(path);

        Budgets.Ran(LitRsIndexWorkForOneRecord, () =>
        {
            Index.Holder.SourceWritten([new PluginWritten(plugin.Key, [path])]);
            Waits.Reached(() => Index.CopyIn(formKey, plugin.Key) is null, "the deleted record gone from reads");
        }, "A record its writer deleted reaching reads");
    }

    [RealSizeFact]
    public void ARecordItsWriterCreated_ReachesReadsWithinLitRsIndexWorkForOneRecord()
    {
        var plugin = Modlist.BigSourcePlugin;
        var (formKey, model) = ($"FFF000:{plugin.Name}", Index.DocumentOf(Modlist.TheManyDocuments[0], plugin.Key));
        var body = plugin.SourceTextOf(model)
            .Replace(model.FormKey, formKey, StringComparison.Ordinal)
            .Replace($"\"{model.EditorId}\"", "\"Created\"", StringComparison.Ordinal);
        var repository = SourceMods.RepositoryOf(plugin);
        var created = repository.ChangesToPut(plugin.Key, new SourceDocument(formKey, model.RecordType, "Created", body)).Value()
            .Under(repository.SourceFolder).Documents.Single();
        using var restored = new CreatedPutBack(created.Path, realSize, () => CheckEnded() && Index.CopyIn(formKey, plugin.Key) is null);
        File.WriteAllText(created.Path, created.Text);

        Budgets.Ran(LitRsIndexWorkForOneRecord, () =>
        {
            Index.Holder.SourceWritten([new PluginWritten(plugin.Key, [created.Path])]);
            Waits.Reached(() => Index.RowOf(formKey, plugin.Key) is { EditorId: "Created" }, "the created record in reads");
        }, "A record its writer created reaching reads");
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
