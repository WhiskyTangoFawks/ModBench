using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

[Collection(TimedCollection.Name)]
public sealed class LoadOrderAtScaleTests
{
    private static readonly TimeSpan OneGesture = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan Navigating = TimeSpan.FromSeconds(0.1);
    private static readonly TimeSpan LitRsSevenHundredPluginsInTenSeconds = TimeSpan.FromSeconds(10) / 700;

    [Fact]
    public void ALaunchWithNothingChanged_IsReadyAtTheRatePerPluginThatLaunchesLitRInTenSeconds()
    {
        const int plugins = 200;
        using var scale = new LoadOrderAtScale(plugins);
        scale.Close();

        Budgets.Ran(LitRsSevenHundredPluginsInTenSeconds * plugins, scale.Relaunch, $"A launch of {plugins} plugins with nothing changed");
        Assert.Equal(LoadOrderState.Ready, scale.Index.Status.State);
    }

    [Fact]
    public void APluginWhoseWholeTreeIsUncommitted_IsIndexedWithinTwoSecondsOfArriving()
    {
        using var scale = new LoadOrderAtScale();
        var version = scale.Index.Holder.Apply(scale.LoadOrder(scale.UncommittedPlugin));

        Budgets.Reached(
            TimeSpan.FromSeconds(2),
            () => scale.Index.Status.Version >= version && scale.Index.Status.State == LoadOrderState.Ready,
            $"Indexing {scale.UncommittedPlugin.Name}");
        Assert.Equal(WorkingTreeState.Added, scale.Index.RowOf(scale.AReferenceInTheUncommittedCell, scale.UncommittedPlugin.Key)?.WorkingTreeState);
    }

    [Fact]
    public void AnEditToOneReferenceInABigCell_ReachesReadsWithinOneSecond()
    {
        using var scale = new LoadOrderAtScale();
        EditTheReference(scale);

        scale.Index.SignalChange();

        Budgets.Reached(OneGesture, () => EditReachedReads(scale), "An edit to one reference reaching reads");
    }

    [Fact]
    public void ACheckAfterAThousandSeparateDocumentsChange_ReachesReadsWithinOneSecond()
    {
        const int documents = 1_000;
        using var scale = new LoadOrderAtScale(documentsInASourcePlugin: documents);
        for (var d = 0; d < documents; d++)
        {
            var editorId = $"Document{d:D4}";
            scale.ManyDocumentsPlugin.Require().HandEdit(new RecordIdentity(scale.TheManyDocuments[d], "KYWD", editorId), $"\"{editorId}\"", "\"Edited\"");
        }

        scale.Index.SignalChange();

        Budgets.Reached(OneGesture, () => AllEdited(scale), "A check after 1,000 documents changed reaching reads");
    }

    private static bool AllEdited(LoadOrderAtScale scale) =>
        scale.Index.Queries.GetRecords(types: null, scale.ManyDocumentsPlugin.Require().Key, search: "Edited", limit: int.MaxValue, offset: 0)
            .Value().Items.Count(row => row.EditorId == "Edited") == scale.TheManyDocuments.Count;

    private static void EditTheReference(LoadOrderAtScale scale)
    {
        var reference = scale.Index.DocumentOf(scale.AReferenceInTheBigCell, scale.BigCellPlugin.Key);
        scale.BigCellPlugin.HandEdit(reference, $"\"{reference.EditorId}\"", "\"Edited\"");
    }

    private static bool EditReachedReads(LoadOrderAtScale scale) =>
        scale.Index.Queries.GetRenderedDocument(scale.BigCellPlugin.Key, scale.AReferenceInTheBigCell).Value()?.Text
            ?.Contains("\"Edited\"", StringComparison.Ordinal) == true;

    [Fact]
    public void AThousandReferencesTakenOutOfABigCellsDocument_ReachReadsWithinOneSecond()
    {
        using var scale = new LoadOrderAtScale();
        var path = scale.BigCellPlugin.SourceFileOf(scale.Index.DocumentOf(scale.BigCell, scale.BigCellPlugin.Key));
        var cell = JsonNode.Parse(File.ReadAllText(path)).Require().AsObject();
        var temporary = cell["Temporary"].Require().AsArray();
        for (var r = 0; r < 1_000; r++) temporary.RemoveAt(0);
        File.WriteAllText(path, RecordTextCodec.RoundTrip(cell.ToJsonString(), GameRelease.Fallout4, "cell"));

        scale.Index.SignalChange();

        Budgets.Reached(OneGesture, () => CheckEnded(scale) && ReferencesListed(scale) == 3_000, "Taking 1,000 references out of a big cell reaching reads");
    }

    [Fact]
    public void ABigCellsDocumentDeleted_ReachesReadsWithinOneSecond()
    {
        using var scale = new LoadOrderAtScale();
        File.Delete(scale.BigCellPlugin.SourceFileOf(scale.Index.DocumentOf(scale.BigCell, scale.BigCellPlugin.Key)));

        scale.Index.SignalChange();

        Budgets.Reached(OneGesture, () => CheckEnded(scale) && ReferencesListed(scale) == 0, "Deleting a big cell's document reaching reads");
        Assert.Null(scale.Index.CopyIn(scale.BigCell, scale.BigCellPlugin.Key));
    }

    private static bool CheckEnded(LoadOrderAtScale scale) => scale.Index.Status.State != LoadOrderState.Reconciling;

    private static int ReferencesListed(LoadOrderAtScale scale) =>
        scale.Index.Queries.GetCellChildRecords(scale.BigCellPlugin.Key, scale.BigCell).Value().Temporary.Count;

    [Fact]
    public void ABigCell_OpensWithinOneSecond()
    {
        using var scale = new LoadOrderAtScale();
        RenderedDocument? opened = null;

        Budgets.Ran(OneGesture, () => opened = scale.Index.Queries.GetRenderedDocument(scale.BigCellPlugin.Key, scale.BigCell).Value(), "Opening a big cell");
        Assert.Contains("\"BigCell\"", opened?.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ABigCell_ListsItsReferencesWithinOneSecond()
    {
        using var scale = new LoadOrderAtScale();
        CellChildRecords? listed = null;

        Budgets.Ran(OneGesture, () => listed = scale.Index.Queries.GetCellChildRecords(scale.BigCellPlugin.Key, scale.BigCell).Value(), "Expanding a big cell");
        Assert.Equal(4_000, listed?.Temporary.Count);
    }

    [Fact]
    public void APluginsOverrides_AreJudgedWithinItsMastersInOneCallWithinTheQueryBudget()
    {
        using var scale = new LoadOrderAtScale();
        IReadOnlyList<RecordCopyStates>? judged = null;

        Budgets.Ran(OneGesture, () => judged = scale.Index.Queries.GetCopyStates(scale.RecordsTheOverridingPluginOverrides, scale.OverridingPlugin).Value(), "Judging 1,500 overrides within their masters");
        Assert.All(judged ?? [], record => Assert.Equal(2, record.Copies.Count));
        Assert.Equal(scale.RecordsTheOverridingPluginOverrides.Count, judged?.Count);
    }

    [Fact]
    public void TheConflictStackOfARecordWithManyCopies_ComparesWithinTheNavigationBudget()
    {
        const int copies = 200;
        using var scale = new LoadOrderAtScale(copies);
        var stack = scale.PluginsHoldingTheOverriddenRecord.Select(p => new RecordCopy(scale.AnOverriddenRecord, p.Key)).ToList();
        CompareRecordsAnswer? compared = null;

        Budgets.Ran(Navigating, () => compared = scale.Index.Queries.GetCompareRecords(stack).Value(), "Comparing a record of 200 copies");
        Assert.Equal(copies, compared?.Compare?.Overrides.Count);
    }
}
