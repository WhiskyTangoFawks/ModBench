using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
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
                "aggression", J("\"Unaggressive\""), J("\"Frenzied\""))
        };
        return svc.StageGroup("edit", null, members);
    }

    // C1
    [Fact]
    public async Task Save_GroupWithNoChanges_ReturnsNoChanges()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var session = new StubSession();
        var saver = new PluginSaver(changes, session);

        var result = await saver.Save(Guid.NewGuid());

        Assert.IsType<SaveGroupResult.NoChanges>(result);
    }

    // C2
    [Fact]
    public async Task Save_GroupWithChanges_ReturnsSaved()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        var saver = new PluginSaver(changes, session);

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
        var saver = new PluginSaver(changes, session);

        await saver.Save(group.Id);

        Assert.Empty(changes.GetChanges(groupId: group.Id));
        Assert.Equal("committed-marker", await File.ReadAllTextAsync(session.LastDestPath!)); // Commit() moved content to dest
        Assert.False(Directory.Exists(session.LastTmpDir!)); // Dispose() cleaned up the tmp dir
        File.Delete(session.LastDestPath!);
    }

    // C4
    [Fact]
    public async Task Save_WhenPrepareFails_ChangesPreserved()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "A.esp");
        var session = new StubSession();
        session.SetPrepareResponse(() => Task.FromException<PreparedPluginSave>(new IOException("disk full")));
        var saver = new PluginSaver(changes, session);

        await Assert.ThrowsAsync<IOException>(() => saver.Save(group.Id));

        Assert.NotEmpty(changes.GetChanges(groupId: group.Id));
    }

    // C5
    [Fact]
    public async Task Save_WhenSecondPrepareFails_FirstTempCleanedup()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        // Stage group spanning 2 plugins
        var groupId = Guid.NewGuid();
        changes.Upsert("000001:A.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            groupId: groupId);
        changes.Upsert("000001:B.esp", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            groupId: groupId);

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
        var saver = new PluginSaver(changes, session);

        await Assert.ThrowsAsync<IOException>(() => saver.Save(groupId));

        Assert.NotNull(firstTmpPath);
        Assert.False(File.Exists(firstTmpPath), "First temp file should have been cleaned up by Dispose()");
    }

    // C6
    [Fact]
    public async Task Save_MultiPlugin_ReindexedAsBatch()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var groupId = Guid.NewGuid();
        changes.Upsert("000001:A.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            groupId: groupId);
        changes.Upsert("000001:B.esp", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            "user", null, new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") },
            groupId: groupId);

        var session = new StubSession();
        var saver = new PluginSaver(changes, session);

        await saver.Save(groupId);

        var call = Assert.Single(session.BatchReindexCalls);
        Assert.Contains("A.esp", call);
        Assert.Contains("B.esp", call);
    }

    // C7
    [Fact]
    public async Task Save_ImmutablePlugin_ReturnsImmutablePluginResult()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "Immutable.esm");
        var session = new StubSession();
        session.SetSession(new StubGameSession([MakeImmutablePlugin("Immutable.esm")]));
        var saver = new PluginSaver(changes, session);

        var result = await saver.Save(group.Id);

        var immutable = Assert.IsType<SaveGroupResult.ImmutablePlugin>(result);
        Assert.Equal("Immutable.esm", immutable.Plugin);
        Assert.NotEmpty(changes.GetChanges(groupId: group.Id)); // early exit preserves pending changes
    }

    // --- helpers ---

    private static SaveResult EmptySaveResult() => new(string.Empty, [], [], [], []);

    private static PluginMetadata MakeImmutablePlugin(string name) =>
        new(name, string.Empty, 0, false, true, [], 0, IsImmutable: true);

    private sealed class StubSession : ISessionManager, IDisposable
    {
        private readonly Queue<Func<Task<PreparedPluginSave>>> _prepareQueue = new();
        private readonly List<IReadOnlyList<string>> _batchReindexed = [];
        private IGameSession _session = new StubGameSession([]);

        public IReadOnlyList<IReadOnlyList<string>> BatchReindexCalls => _batchReindexed;
        public string? LastTmpDir { get; private set; }
        public string? LastDestPath { get; private set; }

        public void SetPrepareResponse(Func<Task<PreparedPluginSave>> fn) => _prepareQueue.Enqueue(fn);
        public void SetSession(IGameSession session) => _session = session;

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
        public Task ReindexPlugins(IReadOnlyList<string> plugins) { _batchReindexed.Add(plugins); return Task.CompletedTask; }

        public void Dispose() => _session.Dispose();

        public IGameSession? Session => _session;
        public IRecordReader? Repository => throw new NotSupportedException();
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
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
        public string DataFolderPath => throw new NotSupportedException();
        public GameRelease GameRelease => throw new NotSupportedException();
        public ILinkCache LinkCache => throw new NotSupportedException();
        public string? FilterSql { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public IModGetter? GetMod(string pluginName) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
