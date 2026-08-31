using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

// #215: every Map*Endpoints handler logs an Info-level "command received" line before doing any
// work — every handler has this line as its literal first statement (verified by inspection, not
// by these tests, which don't assert ordering directly). These tests call a representative handler
// per endpoints file directly (bypassing HTTP/Serilog — see #215 plan: Serilog's
// UseSerilog(writeToProviders: false) makes host-level log capture unreliable) and assert: (a) the
// Info-level entry is present and carries the raw (pre-decode) request parameter, and (b) for
// LoadOrderEndpoints.PutLoadOrder specifically, the entry still fires when the request fails
// validation and returns early — proving the line isn't gated behind a success path. The remaining
// handlers get the identical one-line addition without a dedicated test.
//
// #529 retired this pattern from PluginEndpoints specifically: its "Received ..." lines were
// redundant with the per-request Serilog summary line (UseSerilogRequestLogging) and were deleted
// rather than kept, taking this file's former PluginEndpoints.CreatePlugin coverage with them. The
// #215 pattern (and this file's remaining tests) still stand for LoadOrderEndpoints,
// WorldspaceEndpoints and RecordEndpoints, which #529 was scoped away from.
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

            LoadOrderEndpoints.PutLoadOrder(req, new StubMirror(), new ExternalChangeWatcher(), loggerFactory);

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
        // Acceptance criterion: the reception line fires on every call, including ones that go on to
        // fail — this request fails validation (400) before LoadOrderMirror.LoadExplicit is called.
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var mirror = new StubMirror();
        var req = new LoadOrderRequest([], "Z:\\does-not-exist", "Z:\\does-not-exist", "Fallout4");

        var result = LoadOrderEndpoints.PutLoadOrder(req, mirror, new ExternalChangeWatcher(), loggerFactory);

        var problem = Assert.IsAssignableFrom<Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
        Assert.False(mirror.LoadCalled); // confirms this is the pre-load validation-failure path
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

    private sealed class StubMirror : ILoadOrderMirror
    {
        public bool LoadCalled { get; private set; }
        public ILoadOrder? LoadOrder => null;
        public IRecordReads? Reads => null;
        public IRecordIndex? Index => null;
        // #274: these stubs never load, so they are always in the no-load order state.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => throw new NoLoadOrderException();
        public void Reconcile(
            string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
            string? instanceRoot = null) => LoadCalled = true;
        public void Close() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name, string path, string origin) =>
            new(name, name, 0, false, false, [], 0, false, true, origin, [], true, true, true);
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugin(PluginKey key) => throw new NotSupportedException();
        public void UnindexPlugin(PluginKey key) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
        public void ReapplyFilter() => throw new NotSupportedException();
    }

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
        public IReadOnlyList<string> GetRecordTypes() => throw new NotSupportedException();
        public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            throw new NotSupportedException();
        public RecordDetail? GetRecord(string formKey) => throw new NotSupportedException();
        public CompareResult? GetCompare(string formKey) => throw new NotSupportedException();
        public IReadOnlyList<ConflictRecord> GetConflicts() => throw new NotSupportedException();
        public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null) => throw new NotSupportedException();
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => [];
        public IReadOnlyList<string> GetConditionFunctions() => throw new NotSupportedException();
        public IReadOnlyList<string> GetConditionRunOnTargets() => throw new NotSupportedException();
    }
}
