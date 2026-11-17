using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ReadOutOfMemoryTests : IDisposable
{
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("read-out-of-memory")
        .WithPlugin("Plugin.esp", mod => mod.Npcs.AddNew("Npc")).Build();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void AReadDuckDbRunsOutOfMemoryFor_IsRefusedSayingSo()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1MB'");

        var refused = index.Queries.GetProblems().Refused();

        Assert.Equal(IndexRefusal.OutOfMemory, refused.Refusal);
        Assert.Matches(@"\AmEdit's record index ran out of memory for this read: Out of Memory Error: [^\n]*\z", refused.Message);
    }

    private const string MoreThanAMegabyte = "SELECT n AS form_key FROM range(20000000) t(n) ORDER BY random()";

    [Fact]
    public void ASelectDuckDbRunsOutOfMemoryFor_IsRefusedSayingSo_AndHowToSelectBodies_NotAnsweredAsBadSql()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1MB'");

        var refused = index.Queries.SelectRows(MoreThanAMegabyte).Refused();

        Assert.Equal(IndexRefusal.OutOfMemory, refused.Refusal);
        Assert.EndsWith(" A sort or a join that carries body holds all of it in memory: find the keys on narrow columns, then select body for those keys.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ASelectThatRunsOutOfMemoryBeforeItsFirstRow_IsRefusedSayingHowToSelectBodies()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        Waits.Reached(() => index.Status is { State: LoadOrderState.Ready, Validating: false }, "the index at rest");
        index.Settled();
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        using var fullPool = new FilledMemory(IndexFiles.In(_fixture.InstanceRoot));

        var refused = index.Queries.SelectRows("SELECT 1 AS form_key").Refused();

        Assert.Equal(IndexRefusal.OutOfMemory, refused.Refusal);
        Assert.EndsWith(" A sort or a join that carries body holds all of it in memory: find the keys on narrow columns, then select body for those keys.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFilterWhoseMatchesDuckDbRunsOutOfMemoryFor_IsRefusedSayingSo()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1MB'");

        var refused = index.Queries.SetFilter(MoreThanAMegabyte, "filter.sql");

        Assert.Equal(IndexRefusal.OutOfMemory, refused?.Refusal);
    }

    [Fact]
    public void ASelectRefusedForMemory_IsFollowedByASelectThatAnswers_AndByACheckpoint()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1MB'");
        Assert.Equal(IndexRefusal.OutOfMemory, index.Queries.SelectRows(MoreThanAMegabyte).Refused().Refusal);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1GB'");

        using var answered = index.Queries.SelectRows("SELECT 1 AS form_key").Value();

        Assert.Single(answered.Rows());
        IndexFiles.Checkpointed(_fixture.InstanceRoot);
    }
}
