using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

public sealed class PluginSaverSaveGroupTests
{
    // #371: none of this file's fixture plugins carry a resolvable origin folder (MakeLoadOrderPlugin
    // leaves Path empty), so LedgerGroupCommitter.CommitGroupSaveAsync is always called with an empty
    // touched-record list here and never actually reaches the ledger repo — a shared instance over a
    // scratch root is enough; the save-time ledger commit itself is covered end to end (real git,
    // real save endpoint) by SaveChangeGroupLedgerCommitApiTests.
    private static readonly LedgerGroupCommitter LedgerCommitter = new(
        new LedgerRepository(
            new LedgerOptions(Path.Combine(Path.GetTempPath(), "medit-pluginsaver-tests-ledger")),
            NullLogger<LedgerRepository>.Instance),
        new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
        SharedSchemaReflector.Instance,
        NullLogger<LedgerGroupCommitter>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

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
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var saved = Assert.IsType<SaveGroupResult.Saved>(result);
        Assert.Null(saved.ReindexFailure);
        File.Delete(session.LastDestPath!);
    }

    // #373 review, closed by #391: EditOrchestrator now refuses both directions (Renumber() blocks
    // a target with a pending delete; DeleteRecords() blocks a target with a pending renumber), so
    // this ambiguous state can no longer arise through the public API — this test instead reaches
    // it the only way still available, by staging both lifecycle rows directly via StageChanges,
    // bypassing EditOrchestrator's guard entirely. Neither row alone unions with the other
    // (ADR-0028: a node's own identity match isn't an edge) — a referrer's pending reference to the
    // target bridges both into one component via edge rule 1, exactly the shape a real cascade
    // (AddNullificationMembers / Renumber's own crossPluginRefs) produces and the only way both
    // lifecycle rows reach one Save() call together. PluginSaver.CollectTouchedRecords must fail
    // loudly rather than silently pick one — and the failure must happen where nothing durable has
    // committed yet, so the pending changes survive for the caller to actually resolve.
    [Fact]
    public async Task Save_FormKeyHasBothAPendingDeleteAndAPendingRenumber_ThrowsAndPreservesPendingChanges()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        const string targetFormKey = "000001:A.esp";

        // A.esp/B.esp — the default StubSession's own known, mutable load-order plugins (see its
        // own remarks below); anything else is refused before ever reaching CollectTouchedRecords.
        var members = new[]
        {
            new GroupMember(targetFormKey, "A.esp", "npc_", PendingChangeConstants.DeleteChangeType,
                PendingChangeConstants.DeleteFieldPath, J("null"), J("null"), Source: "user", ParentCell: null, PlacementGroup: null, Origin: "Data"),
            new GroupMember(targetFormKey, "A.esp", "npc_", PendingChangeConstants.RenumberChangeType,
                PendingChangeConstants.RenumberFieldPath, J($"\"{targetFormKey}\""), J("\"000002:A.esp\""), Source: "user", ParentCell: null, PlacementGroup: null, Origin: "Data"),
        };
        var group = changes.StageChanges(members);

        changes.Upsert(new PendingChangeUpsert(
            "000003:B.esp", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["keywords"] = J($"[\"{targetFormKey}\"]") },
            "user", null, [],
            FormRefs: [new PendingFormRef("keywords", "keywords", targetFormKey)],
            ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));

        // Precondition sanity check: all three rows (delete, renumber, referrer) really did land in
        // one component before Save runs — otherwise this test would prove nothing about the guard.
        Assert.Equal(3, changes.GetChanges(memberChangeId: group.Id).Count);

        var session = new StubSession();
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => saver.Save(group.Id));

        Assert.NotEmpty(changes.GetChanges(memberChangeId: group.Id));
    }

    // C9
    [Fact]
    public async Task Save_ImmutablePlugin_ReturnsImmutablePluginResult()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "Immutable.esm");
        var session = new StubSession();
        session.SetSession(new StubGameSession([MakeImmutablePlugin("Immutable.esm")]));
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var immutable = Assert.IsType<SaveGroupResult.ImmutablePlugin>(result);
        Assert.Equal("Immutable.esm", immutable.Plugin);
        Assert.NotEmpty(changes.GetChanges(memberChangeId: group.Id)); // early exit preserves pending changes
    }

    // #306 AC2: a plugin absent from Plugins entirely is not a legitimate write target either — the
    // null lookup must refuse up front, not fall through as "not immutable" and proceed to a save
    // that would only fail later (SessionManager.RequirePlugin's KeyNotFoundException).
    [Fact]
    public async Task Save_PluginAbsentFromSession_ReturnsImmutablePluginResult()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "Ghost.esp");
        var session = new StubSession(); // default session's known plugins are A.esp/B.esp — Ghost.esp is neither
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        var immutable = Assert.IsType<SaveGroupResult.ImmutablePlugin>(result);
        Assert.Equal("Ghost.esp", immutable.Plugin);
        Assert.NotEmpty(changes.GetChanges(memberChangeId: group.Id)); // early exit preserves pending changes
    }

    // #306 AC3: the mis-hit this ticket removes — an unscoped FirstOrDefault lands on whichever
    // entry sits first in Plugins, and an unlisted copy is always immutable. Not reachable through
    // the real GameSession/SessionManager: unlisted copies are only ever appended to Plugins after
    // a completed, blocking session load, so a first-match happens to be correct there today —
    // this test constructs the reversed order directly, which is the only way to pin the scoping
    // down as an invariant rather than an accident of append order.
    [Fact]
    public async Task Save_UnlistedCopyListedFirst_StillSavesTheLoadOrderCopy()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var group = StageGroupChange(changes, "Shared.esp");
        var session = new StubSession();
        session.SetSession(new StubGameSession([
            MakeUnlistedPlugin("Shared.esp", "ModB"),
            MakeLoadOrderPlugin("Shared.esp", "ModA"),
        ]));
        var saver = new PluginSaver(changes, session, LedgerCommitter, NullLogger<PluginSaver>.Instance);

        var result = await saver.Save(group.Id);

        Assert.IsType<SaveGroupResult.Saved>(result);
        File.Delete(session.LastDestPath!);
    }

    // --- helpers ---

    private static SaveResult EmptySaveResult() => new(string.Empty, [], [], [], []);

    private static PluginMetadata MakeImmutablePlugin(string name) =>
        new(name, string.Empty, 0, false, true, [], 0, IsImmutable: true, Origin: "Data");

    private static PluginMetadata MakeLoadOrderPlugin(string name, string origin) =>
        new(name, string.Empty, 0, false, true, [], 0, IsImmutable: false, Origin: origin, InLoadOrder: true);

    private static PluginMetadata MakeUnlistedPlugin(string name, string origin) =>
        new(name, string.Empty, 0, false, true, [], 0,
            IsImmutable: true, Origin: origin, Participates: false, InLoadOrder: false);

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

        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) => throw new NotSupportedException();

        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins)
        {
            _batchReindexed.Add(plugins);
            return _reindexResponse?.Invoke() ?? Task.CompletedTask;
        }

        public void Dispose() => Session!.Dispose();

        // #306: every test in this file that doesn't call SetSession saves against "A.esp" or
        // "B.esp" (StageGroupChange/StageCrossPluginComponent), so the default session carries
        // load-order, mutable metadata for exactly those two names — otherwise LoadOrderPlugin's
        // null-means-refuse guard would refuse every one of them, which isn't what those tests are
        // about. Tests that care about immutability or session membership call SetSession with
        // their own plugin list instead (Save_ImmutablePlugin_ReturnsImmutablePluginResult,
        // Save_PluginAbsentFromSession_ReturnsImmutablePluginResult, etc.).
        public IGameSession? Session { get; private set; } = new StubGameSession([
            MakeLoadOrderPlugin("A.esp", "Data"),
            MakeLoadOrderPlugin("B.esp", "Data"),
        ]);
        public IRecordReader? Repository => throw new NotSupportedException();
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;
        public void Load(string d, string p, GameRelease g) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
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

        // #373: PluginSaver.Save now reads GameRelease unconditionally (to pass to
        // LedgerGroupCommitter.CommitGroupSaveAsync) rather than only on paths this stub already
        // supported — a harmless concrete value, same convention every other fixture in this repo
        // uses, not a behavior this class's own tests exercise.
        public GameRelease GameRelease => GameRelease.Fallout4;
        public string? FilterSql { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
