using System.Diagnostics;
using MEditService.Codec.Serialization;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;

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
    public void AnEditToOneReference_ReachesReadsInAboutTheSameTimeWithFifteenTimesThePlugins()
    {
        var few = TimeToReachReads(plugins: 20);
        var many = TimeToReachReads(plugins: 300);

        Assert.True(many <= few * 1.5, $"An edit took {many.TotalSeconds:F2} s with 300 plugins and {few.TotalSeconds:F2} s with 20.");
    }

    [Fact]
    public void ACheckAfterAThousandSeparateDocumentsChange_ReachesReadsWithinOneSecond()
    {
        const int documents = 1_000;
        using var scale = new LoadOrderAtScale(documentsInASourcePlugin: documents);
        for (var d = 0; d < documents; d++)
        {
            var editorId = $"Document{d:D4}";
            scale.ManyDocumentsPlugin.HandEdit(new RecordIdentity(scale.TheManyDocuments[d], "KYWD", editorId), $"\"{editorId}\"", "\"Edited\"");
        }

        scale.Index.SignalChange();

        Budgets.Reached(OneGesture, () => scale.Index.BodyOf(scale.TheManyDocuments[^1], scale.ManyDocumentsPlugin.Key).Contains("\"Edited\"", StringComparison.Ordinal), "A check after 1,000 documents changed reaching reads");
    }

    private static TimeSpan TimeToReachReads(int plugins)
    {
        using var scale = new LoadOrderAtScale(plugins, rows: 6_000, referencesInABigCell: 100);
        EditTheReference(scale);

        var took = Stopwatch.StartNew();
        scale.Index.SignalChange();
        Waits.Reached(() => EditReachedReads(scale), "the edit reaching reads");
        return took.Elapsed;
    }

    private static void EditTheReference(LoadOrderAtScale scale)
    {
        var reference = scale.Index.DocumentOf(scale.AReferenceInTheBigCell, scale.BigCellPlugin.Key);
        scale.BigCellPlugin.HandEdit(reference, $"\"{reference.EditorId}\"", "\"Edited\"");
    }

    private static bool EditReachedReads(LoadOrderAtScale scale) =>
        scale.Index.Queries.GetRenderedDocument(scale.BigCellPlugin.Key, scale.AReferenceInTheBigCell).Value()?.Text
            ?.Contains("\"Edited\"", StringComparison.Ordinal) == true;

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
