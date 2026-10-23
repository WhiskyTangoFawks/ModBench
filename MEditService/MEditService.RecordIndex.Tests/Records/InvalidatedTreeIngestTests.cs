using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class InvalidatedTreeIngestTests : IDisposable
{
    private const string PluginName = "Fixture.esp";

    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggers;
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("invalidated-tree-ingest")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
        .BuildScattered()
        .CompiledPlugin();
    private readonly LoadOrderHolder _holder = new();
    private readonly AbortingTreeSource _source;
    private readonly OpenedIndex _index;

    public InvalidatedTreeIngestTests()
    {
        _loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));
        _source = new AbortingTreeSource(_fixture.InstanceRoot);
        _index = Indexes.Open(_holder, loggerFactory: _loggers, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, [], GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggers.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AnIndexFileInvalidatedAsATreeIngestBegins_FailsTheSnapshot_NotTheTreesRead()
    {
        _source.Arm();
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
        lock (_log) Assert.DoesNotContain(_log, entry => entry.Message.Contains("Could not ingest", StringComparison.Ordinal));
    }
}
