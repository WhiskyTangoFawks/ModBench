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
    private const long SmallMemoryLimit = 40_000_000;
    private const int BodyLength = 2_000;
    private const int BodyCountAFifthOverTheSmallLimit = 24_000;

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
    public void AnIndexOpened_RemovesTheSpoolFilesAKilledProcessLeft()
    {
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records)))).Dispose();
        var left = Path.Combine(Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot)).Require(), "killed.spool");
        File.WriteAllText(left, "rows");

        using var again = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records))));

        Assert.False(File.Exists(left));
    }

    [Fact]
    public void ASpoolFileThatCannotBeRemoved_LeavesTheIndexOpenedAndIntact()
    {
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records)))).Dispose();
        IndexFiles.Execute(_fixture.InstanceRoot, "CREATE TABLE kept_marker (x INTEGER)");
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        var folder = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot)).Require();
        var stuck = Directory.CreateDirectory(Path.Combine(folder, "stuck.spool"));
        File.WriteAllText(Path.Combine(stuck.FullName, "held"), "rows");

        using var again = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records))));

        Assert.Equal("1", IndexFiles.Rows(_fixture.InstanceRoot, "SELECT count(*) FROM duckdb_tables() WHERE table_name = 'kept_marker'").Single().Single());
    }

    [Fact]
    public void ASelectsRows_AreAllServed_AndNoSpoolFileOutlivesThem()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records))));
        var folder = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot)).Require();

        using (var rows = index.Queries.SelectRows("SELECT form_key FROM records").Value())
            Assert.True(rows.Rows().Count() >= Records);

        Assert.Empty(Directory.GetFiles(folder, "*.spool"));
    }

    [Fact]
    public void ASelectJoiningCopiesToTheirMastersRecordsOfTheSameBody_AnswersInMemoryTheBodiesOutgrow()
    {
        const int copied = 5;
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter(
            (Master, () => Items(Master, BodyCountAFifthOverTheSmallLimit, BodyLength)),
            (Later, () => Items(Master, copied, BodyLength))), memoryLimit: SmallMemoryLimit);

        var rows = index.Queries.Selected($"""
            SELECT c.form_key FROM records c JOIN records m ON m.form_key = c.form_key AND m.plugin = c.form_key_plugin
            WHERE c.plugin = '{Later}' AND c.form_key_plugin <> c.plugin AND c.body = m.body
            """);

        Assert.Equal(copied, rows.Length);
    }

    [Theory]
    [InlineData(100_000_000, "1")]
    [InlineData(500_000_000, "2")]
    public void TheRecordIndex_RunsADuckDbThreadPer250MbOfItsMemoryLimit_AndAtLeastOne(long memoryLimit, string threads)
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, memoryLimit: memoryLimit);

        Assert.Equal(threads, index.Queries.Selected("SELECT current_setting('threads')::VARCHAR AS n").Single().GetProperty("n").GetString());
    }

    [Theory]
    [InlineData("SELECT body FROM records")]
    [InlineData("SELECT body FROM records WHERE record_type = 'misc'")]
    public void ASelectWhoseRowsTogetherOutgrowTheMemoryLimit_AnswersEveryRow(string sql)
    {
        using var index = Indexes.Reconciled(
            _fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, BodyCountAFifthOverTheSmallLimit, BodyLength))), memoryLimit: SmallMemoryLimit);

        using var rows = index.Queries.SelectRows(sql).Value();

        Assert.Equal(BodyCountAFifthOverTheSmallLimit, rows.Rows().Count(row => row.Value().Length > BodyLength));
    }

    [Fact]
    public void AFaultAfterTheFirstRow_EndsTheRowsWithARefusalThatStatesWhatDuckDBGave()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Master, () => Items(Master, Records))));

        using var rows = index.Queries.SelectRows("SELECT CAST(CASE WHEN n < 100000 THEN '1' ELSE 'x' END AS INTEGER) AS v FROM range(200000) t(n)").Value();

        var read = rows.Rows().ToList();
        Assert.All(read[..^1], row => row.Value());
        Assert.InRange(read.Count - 1, 1, 99_999);
        var refused = read[^1].Refused();
        Assert.Equal(IndexRefusal.SelectRejected, refused.Refusal);
        const string TheFaultsReasonOrOnlyTheInterruptThatFollowsIt = "Could not convert string 'x'|^DuckDB interrupted the SELECT partway, and gave no reason";
        Assert.Matches(TheFaultsReasonOrOnlyTheInterruptThatFollowsIt, refused.Message);
    }
}
