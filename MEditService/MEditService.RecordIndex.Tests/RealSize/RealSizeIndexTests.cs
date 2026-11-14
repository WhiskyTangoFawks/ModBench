using System.Globalization;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;

namespace MEditService.RecordIndex.Tests.RealSize;

[Collection(RealSizeCollection.Name)]
public sealed class RealSizeIndexTests(RealSizeIndex realSize)
{
    private static readonly TimeSpan OneGesture = TimeSpan.FromSeconds(1);

    [RealSizeFact]
    public void TheGeneratedModlist_IsIndexedAtLitRsSize()
    {
        Assert.Equal(LoadOrderState.Ready, realSize.Index.Status.State);
        Assert.Equal(RealSizeModlist.Plugins, Count("SELECT count(*) FROM registrations"));
        Assert.Equal(RealSizeModlist.SourceTreePlugins, Count("SELECT count(*) FROM mirror.plugin_derivation WHERE derived_from = 'SourceTree'"));
        Assert.InRange(Count("SELECT count(*) FROM mirror.records"), 3_000_000, 3_200_000);
        Assert.InRange(Count("SELECT count(*) FROM mirror.form_references"), 17_000_000, 19_000_000);
        Assert.InRange(Count("SELECT count(*) FROM mirror.holdings"), 2_800_000, 3_000_000);
        Assert.InRange(Count("SELECT sum(length(body)) FROM mirror.records"), 5_500_000_000, 6_500_000_000);
    }

    private long Count(string sql) =>
        long.Parse(IndexFiles.Rows(realSize.Modlist.InstanceRoot, sql).Single().Single(), CultureInfo.InvariantCulture);

    [RealSizeFact]
    public void ABigCell_OpensWithinOneSecond()
    {
        var (queries, modlist) = (realSize.Index.Queries, realSize.Modlist);
        RenderedDocument? opened = null;

        Budgets.Ran(OneGesture, () => opened = queries.GetRenderedDocument(modlist.Base.Key, modlist.BigCell).Value(), "Opening a big cell");
        Assert.Contains("\"BigCell\"", opened?.Text, StringComparison.Ordinal);
    }
}
