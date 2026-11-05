using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ProblemsReadMemoryTests : IDisposable
{
    private const string Plugin = "Referring.esp";
    private const int RecordCount = 20_000;
    private const int LinksPerRecord = 50;
    private const long MemoryLimit = 32_000_000;

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("problems-read-memory").WithPlugin(Plugin).Build();
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void ABinaryPluginsLinksToMissingRecords_OutgrowingDuckDbsMemoryLimit_LeaveTheProblemsReadAnswering()
    {
        using var index = Indexes.Open(_holder, new LinkingAdapter(Plugin, LinksToMissingRecords), memoryLimit: MemoryLimit);
        index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Empty(index.Queries.GetProblems().Value());
    }

    private static IEnumerable<(string, IEnumerable<string>)> LinksToMissingRecords() =>
        Enumerable.Range(0, RecordCount).Select(i => (
            $"{0x800 + i:X6}:{Plugin}",
            Enumerable.Range(0, LinksPerRecord).Select(j => $"{0x800 + i * LinksPerRecord + j:X6}:Absent.esm")));
}
