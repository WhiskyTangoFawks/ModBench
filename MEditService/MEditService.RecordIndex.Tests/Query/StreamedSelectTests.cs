using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class StreamedSelectTests : IDisposable
{
    private const string Master = "Master.esm";
    private const string Later = "Later.esp";
    private const int Records = 100;

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("streamed-select")
        .WithPlugin(Master).WithPlugin(Later).Build();

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<PluginDocument> Items(string plugin, int count, int nameLength = 10) => Enumerable.Range(0, count).Select(i =>
    {
        var formKey = $"{0x800 + i:X6}:{plugin}";
        return new PluginDocument("misc", formKey, $$"""{"FormKey": "{{formKey}}", "EditorID": "Item{{i}}", "Name": "{{new string('x', nameLength)}}"}""");
    });

    [Fact]
    public async Task ASelectPausedAfterItsFirstRow_HoldsNoWriteBack_AndReadsOnAsTheIndexWasWhenItStarted()
    {
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new MadeUpAdapter((Master, () => Items(Master, Records)), (Later, () => Items(Later, Records))));
        index.Reconcile(holder, _fixture.DataFolder, [_fixture.Plugins[0]], GameRelease.Fallout4, _fixture.InstanceRoot);
        index.SetFilter("SELECT form_key FROM records", "filter.sql");
        using var rows = index.Queries.SelectRows("SELECT form_key FROM records WHERE record_type = 'misc'").Value();
        using var taken = rows.Rows().GetEnumerator();
        Assert.True(taken.MoveNext());

        await Task.Run(() => index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot))
            .WaitAsync(TimeSpan.FromSeconds(30));

        var read = 1;
        while (taken.MoveNext()) read++;
        Assert.Equal(Records, read);
    }

    [Fact]
    public void ASelectWhoseRowsTogetherOutgrowTheMemoryLimit_AnswersEveryRow()
    {
        const int many = 64_000;
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, many, nameLength: 2_000))), memoryLimit: 64_000_000);

        using var rows = index.Queries.SelectRows("SELECT body FROM records").Value();

        Assert.Equal(many, rows.Rows().Count(row => row.Value().Length > 2_000));
    }

    [Fact]
    public void AFaultAfterTheFirstRow_EndsTheRowsWithItsRefusal()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records))));

        using var rows = index.Queries.SelectRows("SELECT CAST(CASE WHEN n < 1000000 THEN '1' ELSE 'x' END AS INTEGER) AS v FROM range(2000000) t(n)").Value();

        var read = rows.Rows().ToList();
        Assert.All(read[..^1], row => row.Value());
        Assert.InRange(read.Count - 1, 1, 999_999);
        Assert.Equal(IndexRefusal.SelectRejected, read[^1].Refused().Refusal);
    }
}
