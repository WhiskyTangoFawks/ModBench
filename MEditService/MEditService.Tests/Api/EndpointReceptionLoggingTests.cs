using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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
// SessionEndpoints.LoadSession specifically, the entry still fires when the request fails
// validation and returns early — proving the line isn't gated behind a success path. The remaining
// handlers get the identical one-line addition without a dedicated test.
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

    // --- SessionEndpoints.LoadSession ---

    [Fact]
    public void LoadSession_ValidRequest_LogsReceivedWithDataFolder()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var tempDir = Directory.CreateTempSubdirectory("medit-215-").FullName;
        try
        {
            var pluginsTxt = Path.Combine(tempDir, "Plugins.txt");
            File.WriteAllText(pluginsTxt, "");
            var req = new SessionLoadRequest(tempDir, pluginsTxt, "Fallout4");

            SessionEndpoints.LoadSession(req, new StubSessionManager(), loggerFactory);

            Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains(tempDir));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void LoadSession_DataFolderMissing_StillLogsReceived()
    {
        // Acceptance criterion: the reception line fires on every call, including ones that go on
        // to fail — this request fails validation (400) before SessionManager.Load is ever called.
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var sessionManager = new StubSessionManager();
        var req = new SessionLoadRequest("Z:\\does-not-exist", "Z:\\does-not-exist\\Plugins.txt", "Fallout4");

        var result = SessionEndpoints.LoadSession(req, sessionManager, loggerFactory);

        var problem = Assert.IsAssignableFrom<Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
        Assert.False(sessionManager.LoadCalled); // confirms this is the pre-Load validation-failure path
        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Z:\\does-not-exist"));
    }

    // --- PluginEndpoints.CreatePlugin ---

    [Fact]
    public void CreatePlugin_ValidRequest_LogsReceivedWithName()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var req = new CreatePluginRequest("NewPlugin.esp");

        PluginEndpoints.CreatePlugin(req, new StubSessionManager(), loggerFactory);

        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("NewPlugin.esp"));
    }

    // --- ChangeEndpoints.PatchRecord ---

    [Fact]
    public void PatchRecord_NoSessionLoaded_StillLogsReceivedWithFormKey()
    {
        // Early-return-before-any-work shape distinct from SessionEndpoints' validation failure:
        // here the guard is "no session loaded" rather than input validation.
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var req = new PatchRecordRequest("Plugin.esp", [], "user", null);

        ChangeEndpoints.PatchRecord("000001:Plugin.esp", req, new StubSessionManager(), new StubEditOrchestrator(), loggerFactory);

        Assert.Contains(entries, e => e.Level == LogLevel.Information && e.Message.Contains("000001:Plugin.esp"));
    }

    // --- WorldspaceEndpoints.GetWorldspaces ---

    [Fact]
    public void GetWorldspaces_ValidRequest_LogsReceivedWithPlugin()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        WorldspaceEndpoints.GetWorldspaces("Plugin.esp", new StubWorldspaceQueryService(), logger);

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

    private sealed class StubSessionManager : ISessionManager
    {
        public bool LoadCalled { get; private set; }
        public IGameSession? Session => null;
        public IRecordReader? Repository => null;
        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => LoadCalled = true;
        public void LoadExplicit(string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin, bool Participates)> plugins, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) =>
            new(name, name, 0, false, false, [], 0, false, true, "Data", [], true);
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    private sealed class StubEditOrchestrator : IEditOrchestrator
    {
        public StageEditResult StageEdit(
            string formKey, string plugin, Dictionary<string, System.Text.Json.JsonElement> fields,
            string source, string? description, string? changeType = null) =>
            new StageEditResult.NoSession();
        public StageEditResult CopyRecordTo(string formKey, string targetPlugin, string source, string? sourcePlugin = null, string? sourceOrigin = null) => throw new NotSupportedException();
        public CreateRecordOutcome CreateRecord(string plugin, string recordType, string? templateFormKey, string source) =>
            throw new NotSupportedException();
        public CreateRecordOutcome CreatePlacedRecord(string plugin, string recordType, string parentCell, string placementGroup,
            string? templateFormKey, string source) => throw new NotSupportedException();
        public DeleteRecordsResult DeleteRecords(IReadOnlyList<(string FormKey, string Plugin)> targets, string source) =>
            throw new NotSupportedException();
        public RenumberResult Renumber(string formKey, uint newFormId, string plugin, string source) => throw new NotSupportedException();
    }

    private sealed class StubWorldspaceQueryService : IWorldspaceQueryService
    {
        public IReadOnlyList<WorldspaceSummary> GetWorldspaces(string plugin) => [];
        public WorldspaceBlocks GetWorldspaceBlocks(string plugin, string worldspaceFormKey) => throw new NotSupportedException();
        public CellReferences GetCellReferences(string plugin, string cellFormKey) => throw new NotSupportedException();
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset) => throw new NotSupportedException();
    }

    private sealed class StubRecordQueryService : IRecordQueryService
    {
        public IReadOnlyList<PluginResponse> GetPlugins() => throw new NotSupportedException();
        public IReadOnlyList<string> GetRecordTypes() => throw new NotSupportedException();
        public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            throw new NotSupportedException();
        public RecordDetail? GetRecord(string formKey) => throw new NotSupportedException();
        public RecordDetail? GetRecordForPlugin(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public string? GetRecordType(string formKey) => throw new NotSupportedException();
        public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) => throw new NotSupportedException();
        public CompareResult? GetCompare(string formKey) => throw new NotSupportedException();
        public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null) => throw new NotSupportedException();
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => [];
        public VmadData? GetVmad(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public IReadOnlyList<string> GetConditionFunctions() => throw new NotSupportedException();
        public IReadOnlyList<string> GetConditionRunOnTargets() => throw new NotSupportedException();
        public PlacementRow? GetPlacement(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public IReadOnlyList<PendingChange> GetChanges(string? formKey = null, Guid? memberChangeId = null) =>
            throw new NotSupportedException();
    }
}
