using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

// Handlers are called directly rather than over HTTP, because UseSerilog(writeToProviders: false)
// makes host-level log capture unreliable. PluginEndpoints is exempt: the per-request
// UseSerilogRequestLogging summary already carries its line.
public sealed class EndpointReceptionLoggingTests
{
    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Information);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    // --- LoadOrderEndpoints.PutLoadOrder ---

    [Fact]
    public void PutLoadOrder_ValidRequest_LogsReceivedWithGameDirectory()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var tempDir = Directory.CreateTempSubdirectory("medit-215-").FullName;
        try
        {
            var req = new LoadOrderRequest([], tempDir, tempDir, "Fallout4");

            using var index = new IndexProjector(MutagenPluginAdapter.Instance, new RefusingIndexFactory());
            LoadOrderEndpoints.PutLoadOrder(req, index, new LoadOrderHolder(), new ModFolderWatcher(), loggerFactory);

            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains(tempDir));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void PutLoadOrder_GameDirectoryMissing_StillLogsReceived()
    {
        // The reception line fires on every call, including ones that go on to fail — this
        // request fails validation (400) before the Index is asked to project anything.
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var factory = new RefusingIndexFactory();
        using var index = new IndexProjector(MutagenPluginAdapter.Instance, factory);
        var req = new LoadOrderRequest([], "Z:\\does-not-exist", "Z:\\does-not-exist", "Fallout4");

        var result = LoadOrderEndpoints.PutLoadOrder(req, index, new LoadOrderHolder(), new ModFolderWatcher(), loggerFactory);

        var problem = Assert.IsAssignableFrom<Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
        Assert.False(factory.Asked); // confirms this is the pre-projection validation-failure path
        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Z:\\does-not-exist"));
    }

    // --- WorldspaceEndpoints.GetWorldspaces ---

    [Fact]
    public void GetWorldspaces_ValidRequest_LogsReceivedWithPlugin()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        WorldspaceEndpoints.GetWorldspaces("Plugin.esp", null, new StubWorldspaceQueryService(), logger);

        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Plugin.esp"));
    }

    // --- RecordEndpoints.GetReferences ---

    [Fact]
    public void GetReferences_ValidRequest_LogsReceivedWithFormKey()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var logger = loggerFactory.CreateLogger(nameof(RecordEndpoints));

        RecordEndpoints.GetReferences("000001:Plugin.esp", new StubRecordQueryService(), logger);

        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("000001:Plugin.esp"));
    }

    // --- Stubs (hand-written, no mocking framework — matches existing test-suite convention) ---

    private sealed class StubWorldspaceQueryService : IWorldspaceQueryService
    {
        public IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin, string? origin = null) => [];
        public WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey, string? origin = null) => throw new NotSupportedException();
        public CellReferences GetCellReferences(string plugin, string cellFormKey, string? origin = null) => throw new NotSupportedException();
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string? origin = null) => throw new NotSupportedException();
    }

    private sealed class StubRecordQueryService : IRecordQueryService
    {
        public IReadOnlyList<PluginResponse> GetPlugins() => throw new NotSupportedException();
        public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            throw new NotSupportedException();
        public RecordDetail? GetRecord(string formKey) => throw new NotSupportedException();
        public CompareResult? GetCompare(string formKey) => throw new NotSupportedException();
        public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null) => throw new NotSupportedException();
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => [];
    }
}
