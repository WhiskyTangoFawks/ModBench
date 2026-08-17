using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

// #300 / ADR-0036: BulkDeleteChanges resolved a `plugin` filter without an origin, so
// `changes.Revert(plugin, formKey)` reverted every origin's pending changes for that filename —
// harmless while a session could only ever hold one plugin per filename, live once #34 lets it
// hold two. The fix resolves origin server-side via PluginOriginResolver, same as
// GetPluginRecordTypes/GetCellReferences (#296).
//
// The target origin is deliberately "ModA", not "Data": PluginOriginResolver.Resolve falls back to
// PluginOrigin.DataDirectory ("Data") whenever it can't find a matching load-order plugin, so a
// fixture whose target origin *is* "Data" can't tell a resolver that found the right plugin from
// one that silently fell back — the elision the ticket warns about is not just a display shortcut,
// it can make a broken resolution path and a working one produce the same answer. "ModA" has no
// such fallback to hide behind: the resolver must actually find it in session metadata.
//
// Three rows for one filename, one call: the "ModB" row proves the fix scopes by the *right*
// origin (not merely "some" origin), and the "Data" row is the elision case itself — a pending
// change staged under the reserved default origin, which must survive a revert scoped to a real
// mod-folder origin exactly as any other non-matching origin would.
public sealed class ChangeEndpointsBulkDeleteOriginTests
{
    private static ILoggerFactory NullLoggerFactory() => LoggerFactory.Create(_ => { });

    [Fact]
    public void BulkDeleteChanges_ScopedToOrigin_LeavesOtherOriginsForSameFilenameUntouched()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        Stage(changes, "FK1", "Override.esp", "ModA"); // target: session resolves Override.esp -> ModA
        Stage(changes, "FK2", "Override.esp", "ModB"); // must survive: different real origin
        Stage(changes, "FK3", "Override.esp", "Data"); // must survive: the elided reserved origin

        var session = new StubSessionManager(new PluginMetadata(
            "Override.esp", "C:\\Override.esp", 0, false, false, [], 0, false, "ModA"));

        var result = ChangeEndpoints.BulkDeleteChanges(
            plugin: "Override.esp", formKey: null, session: session, changes: changes, loggerFactory: NullLoggerFactory());

        var count = Assert.IsType<Ok<int>>(result).Value;
        Assert.Equal(1, count);

        var remaining = changes.GetChanges(plugin: "Override.esp");
        Assert.Equal(2, remaining.Count);
        Assert.DoesNotContain(remaining, c => c.FormKey == "FK1");
        Assert.Equal("ModB", OriginOf(changes, Assert.Single(remaining, c => c.FormKey == "FK2")));
        Assert.Equal("Data", OriginOf(changes, Assert.Single(remaining, c => c.FormKey == "FK3")));
    }

    // #300 review: PluginOriginResolver.Resolve falls back to PluginOrigin.DataDirectory when given
    // a null session, so resolving unconditionally would make "no session loaded" indistinguishable
    // from "this plugin is at the Data origin" — pending_changes outlives its session (Unload never
    // clears it; the service is a DI singleton), so a plugin staged under a real mod origin with no
    // session loaded would silently filter to zero rows instead of reverting. With no session there
    // is no load order to resolve an origin against, so origin must stay null and the bulk revert
    // falls back to its pre-#300 filename-only scope exactly.
    [Fact]
    public void BulkDeleteChanges_NoSessionLoaded_StillRevertsByFilenameAlone()
    {
        var changes = DuckDbTestFactory.MakePendingChangeService();
        Stage(changes, "FK1", "Override.esp", "ModA"); // a real non-Data origin, staged before the session that loaded it was unloaded

        var session = new StubSessionManager(plugin: null);

        var result = ChangeEndpoints.BulkDeleteChanges(
            plugin: "Override.esp", formKey: null, session: session, changes: changes, loggerFactory: NullLoggerFactory());

        var count = Assert.IsType<Ok<int>>(result).Value;
        Assert.Equal(1, count);
        Assert.Empty(changes.GetChanges(plugin: "Override.esp"));
    }

    private static void Stage(IPendingChangeService changes, string formKey, string plugin, string origin) =>
        changes.Upsert(new PendingChangeUpsert(
            formKey, plugin, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["name"] = System.Text.Json.JsonDocument.Parse("\"x\"").RootElement },
            "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType,
            ParentCell: null, PlacementGroup: null, Origin: origin));

    // PendingChange itself doesn't carry Origin (#296's read DTOs weren't touched here), so this
    // reaches through GetChanges' own origin filter to prove each survivor's origin rather than
    // trusting FormKey alone to stand in for it.
    private static string OriginOf(IPendingChangeService changes, PendingChange change) =>
        new[] { "Data", "ModA", "ModB" }.Single(o => changes.GetChanges(plugin: change.Plugin, formKey: change.FormKey, origin: o).Count > 0);

    private sealed class StubSessionManager(PluginMetadata? plugin) : ISessionManager
    {
        public IGameSession? Session { get; } = plugin != null ? new StubGameSession(plugin) : null;
        public IRecordReader? Repository => null;
        public SessionStatus Status => SessionStatus.None;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public void RereadPlugin(string plugin, string newPath, string newOrigin) => throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    private sealed class StubGameSession(PluginMetadata plugin) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins => [plugin];
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName, string origin) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
