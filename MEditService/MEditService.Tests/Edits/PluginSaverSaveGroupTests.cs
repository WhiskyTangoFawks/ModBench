using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

public sealed class PluginSaverSaveGroupTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static ChangeGroup StageGroupChange(DuckDbPendingChangeService svc, string plugin)
    {
        var members = new[]
        {
            new GroupMember("000001:Test.esp", plugin, "npc_", "field_edit",
                "aggression", J("\"Unaggressive\""), J("\"Frenzied\""), Source: "system", ParentCell: null, PlacementGroup: null, Origin: "Data")
        };
        return svc.StageChanges(members);
    }

    /// <summary>
    /// Stages a component that genuinely spans A.esp and B.esp, returning a member change id naming
    /// it. Two field edits sharing a group_id no longer make a group (ADR-0028) — a cross-plugin
    /// group has to be earned by a real dependency, as a renumber's cascading reference updates earn
    /// theirs. Here it is edge rule 1: B.esp's edit holds a FormLink to a record that only A.esp's
    /// pending $create brings into existence.
    /// </summary>
    private static Guid StageCrossPluginComponent(DuckDbPendingChangeService svc)
    {
        const string createdFormKey = "000001:A.esp";
        var created = svc.Upsert(new PendingChangeUpsert(
            createdFormKey, "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: "create", ParentCell: null, PlacementGroup: null, Origin: "Data"));

        svc.Upsert(new PendingChangeUpsert(
            "000001:B.esp", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            [new PendingFormRef("aggression", "aggression", createdFormKey)], ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));

        return created[0].Id;
    }

    // C1
    [Fact]
    public async Task Save_GroupWithNoChanges_ReturnsNoChanges()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(Guid.NewGuid());

        Assert.IsType<SaveGroupResult.NoChanges>(result);
    }

    // #272 / ADR-0036: SaveGroupResponse.ByPlugin is keyed by the compound column identity, but the
    // physical write/reindex target must still be the real plugin filename — never the compound
    // key itself, which would break both the on-disk write path and ReindexPlugins.
    [Fact]
    public async Task Save_NonDataOrigin_KeysByColumnButReindexesRealPluginFilename()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var members = new[]
        {
            new GroupMember("000001:Test.esp", "A.esp", "npc_", "field_edit",
                "aggression", J("\"Unaggressive\""), J("\"Frenzied\""), Origin: "ModA", Source: "system", ParentCell: null, PlacementGroup: null),
        };
        var group = changes.StageChanges(members);
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var saved = Assert.IsType<SaveGroupResult.Saved>(result);
        Assert.Contains("A.esp|ModA", saved.ByPlugin.Keys);
        Assert.Contains(session.BatchReindexCalls, batch => batch.Contains("A.esp"));
        Assert.DoesNotContain(session.BatchReindexCalls, batch => batch.Any(p => p.Contains('|')));
        File.Delete(session.LastDestPath!);
    }

    // C2
    [Fact]
    public async Task Save_GroupWithChanges_ReturnsSaved()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        Assert.IsType<SaveGroupResult.Saved>(result);
    }

    // C3
    [Fact]
    public async Task Save_Success_ClearsPendingChanges()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await saver.Save(group.Id);

        Assert.Empty(changes.GetChanges(memberChangeId: group.Id));
        File.Delete(session.LastDestPath!);
    }

    // C4
    [Fact]
    public async Task Save_Success_CommitsContentToDestination()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await saver.Save(group.Id);

        Assert.Equal("committed-marker", await File.ReadAllTextAsync(session.LastDestPath!));
        File.Delete(session.LastDestPath!);
    }

    // C5
    [Fact]
    public async Task Save_Success_CleansUpTempDir()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await saver.Save(group.Id);

        Assert.False(Directory.Exists(session.LastTmpDir!));
        File.Delete(session.LastDestPath!);
    }

    // C6
    [Fact]
    public async Task Save_WhenPrepareFails_ChangesPreserved()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        session.SetPrepareResponse(() => Task.FromException<PreparedPluginSave>(new IOException("disk full")));
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await Assert.ThrowsAsync<IOException>(() => saver.Save(group.Id));

        Assert.NotEmpty(changes.GetChanges(memberChangeId: group.Id));
    }

    // C7
    [Fact]
    public async Task Save_WhenSecondPrepareFails_FirstTempCleanedup()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var groupId = StageCrossPluginComponent(changes);

        var session = new StubSession();
        string? firstTmpPath = null;
        session.SetPrepareResponse(() =>
        {
            var tmp = Path.GetTempFileName();
            firstTmpPath = tmp;
            var dir = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir);
            var tmpInDir = Path.Combine(dir, "A.esp");
            File.Copy(tmp, tmpInDir);
            File.Delete(tmp);
            firstTmpPath = tmpInDir;
            return Task.FromResult(new PreparedPluginSave(tmpInDir, tmp, EmptySaveResult()));
        });
        session.SetPrepareResponse(() => Task.FromException<PreparedPluginSave>(new IOException("disk full")));
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await Assert.ThrowsAsync<IOException>(() => saver.Save(groupId));

        Assert.NotNull(firstTmpPath);
        Assert.False(File.Exists(firstTmpPath), "First temp file should have been cleaned up by Dispose()");
    }

    // C8
    [Fact]
    public async Task Save_MultiPlugin_ReindexedAsBatch()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var groupId = StageCrossPluginComponent(changes);

        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await saver.Save(groupId);

        var call = Assert.Single(session.BatchReindexCalls);
        Assert.Contains("A.esp", call);
        Assert.Contains("B.esp", call);
    }

    // C10 — reindex runs after the file+DB commit; a throw there must not turn a committed
    // save into a reported failure. It folds into a named Reindex failure on Saved (#127).
    [Fact]
    public async Task Save_WhenReindexThrows_ReturnsSavedWithNamedReindexFailure()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        session.SetReindexResponse(() => Task.FromException(new IOException("duckdb busy")));
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var saved = Assert.IsType<SaveGroupResult.Saved>(result);
        Assert.NotNull(saved.ReindexFailure);
        Assert.Contains("A.esp", saved.ReindexFailure!.Plugins);
        Assert.Contains("duckdb busy", saved.ReindexFailure.Reason);
        Assert.NotEmpty(saved.ByPlugin); // the per-plugin SaveResults survive
        File.Delete(session.LastDestPath!);
    }

    // C11 — the save really happened: pending changes stay consumed even though reindex failed.
    [Fact]
    public async Task Save_WhenReindexThrows_PendingChangesStayConsumed()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        session.SetReindexResponse(() => Task.FromException(new IOException("duckdb busy")));
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        await saver.Save(group.Id);

        Assert.Empty(changes.GetChanges(memberChangeId: group.Id));
        File.Delete(session.LastDestPath!);
    }

    // C12 — happy path leaves Reindex null.
    [Fact]
    public async Task Save_WhenReindexSucceeds_ReindexFailureIsNull()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var saved = Assert.IsType<SaveGroupResult.Saved>(result);
        Assert.Null(saved.ReindexFailure);
        File.Delete(session.LastDestPath!);
    }

    // C9
    [Fact]
    public async Task Save_ImmutablePlugin_ReturnsImmutablePluginResult()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "Immutable.esm");
        var session = new StubSession();
        session.SetSession(new StubGameSession([MakeImmutablePlugin("Immutable.esm")]));
        var saver = new PluginSaver(changes, session, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var immutable = Assert.IsType<SaveGroupResult.ImmutablePlugin>(result);
        Assert.Equal("Immutable.esm", immutable.Plugin);
        Assert.NotEmpty(changes.GetChanges(memberChangeId: group.Id)); // early exit preserves pending changes
    }

    // --- helpers ---

    private static SaveResult EmptySaveResult() => new(string.Empty, [], [], [], []);

    private static PluginMetadata MakeImmutablePlugin(string name) =>
        new(name, string.Empty, 0, false, true, [], 0, IsImmutable: true, Origin: "Data");

    private sealed class StubSession : ISessionManager, IDisposable
    {
        private readonly Queue<Func<Task<PreparedPluginSave>>> _prepareQueue = new();
        private readonly List<IReadOnlyList<string>> _batchReindexed = [];
        private Func<Task>? _reindexResponse;

        public IReadOnlyList<IReadOnlyList<string>> BatchReindexCalls => _batchReindexed;
        public string? LastTmpDir { get; private set; }
        public string? LastDestPath { get; private set; }

        public void SetPrepareResponse(Func<Task<PreparedPluginSave>> fn) => _prepareQueue.Enqueue(fn);
        public void SetReindexResponse(Func<Task> fn) => _reindexResponse = fn;
        public void SetSession(IGameSession session) => Session = session;

        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes)
        {
            if (_prepareQueue.TryDequeue(out var fn)) return fn();
            var dir = Path.Combine(Path.GetTempPath(), ".medit_tmp_" + Path.GetRandomFileName());
            Directory.CreateDirectory(dir);
            var tmp = Path.Combine(dir, plugin);
            File.WriteAllText(tmp, "committed-marker");
            var dest = Path.GetTempFileName();
            LastTmpDir = dir;
            LastDestPath = dest;
            return Task.FromResult(new PreparedPluginSave(tmp, dest, EmptySaveResult()));
        }

        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins)
        {
            _batchReindexed.Add(plugins);
            return _reindexResponse?.Invoke() ?? Task.CompletedTask;
        }

        public void Dispose() => Session!.Dispose();

        public IGameSession? Session { get; private set; } = new StubGameSession([]);
        public IRecordReader? Repository => throw new NotSupportedException();
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<(string Name, string Path, string Origin, bool Participates)> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    private sealed class StubGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public IReadOnlyList<PluginMetadata> Plugins => plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string DataFolderPath => throw new NotSupportedException();
        public GameRelease GameRelease => throw new NotSupportedException();
        public ILinkCache LinkCache => throw new NotSupportedException();
        public string? FilterSql { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public IModGetter? GetMod(string pluginName) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
