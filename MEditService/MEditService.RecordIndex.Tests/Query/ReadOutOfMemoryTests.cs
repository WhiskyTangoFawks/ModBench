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
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL memory_limit = '1MB'");

        var refused = index.Queries.GetProblems().Refused();

        Assert.Equal(IndexRefusal.OutOfMemory, refused.Refusal);
        Assert.Matches(@"\AmEdit's record index ran out of memory for this read: Out of Memory Error: [^\n]*\z", refused.Message);
    }
}
