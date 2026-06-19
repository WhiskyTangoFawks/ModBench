using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class RenumberRecordTests
{
    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestrator()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    private static (EditOrchestrator orchestrator, StubImmutableSessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithImmutablePlugin(string dataFolder, string pluginsTxtPath, string immutablePlugin)
    {
        var reflector = new SchemaReflector();
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var stubManager = new StubImmutableSessionManager(
            dataFolder, pluginsTxtPath, GameRelease.Fallout4, immutablePlugin, reflector, changes);
        var query = new RecordQueryService(stubManager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(stubManager, query, writer, changes, reflector);
        return (orchestrator, stubManager, changes);
    }

    // --- 409: immutable plugin holds a reference ---

    [Fact]
    public void Renumber_ImmutablePluginHoldsReference_ReturnsImmutableReferences()
    {
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("rn-immutable-ref")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Immutable.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReferencingNPC_RnImmutable");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
            })
            .Build();
        using (data)
        {
            var (orchestrator, stubManager, _) =
                MakeOrchestratorWithImmutablePlugin(data.DataFolder, data.PluginsTxtPath, "Immutable.esp");
            using (stubManager)
            {
                var result = orchestrator.Renumber(kwKey.ToString(), 0x999999, "Source.esp", "user");

                var blocked = Assert.IsType<RenumberResult.ImmutableReferences>(result);
                Assert.NotEmpty(blocked.Blockers);
                // FormKey is the referencing record (NPC in Immutable.esp), Plugin is the blocker plugin
                Assert.Equal("Immutable.esp", blocked.Blockers[0].Plugin);
            }
        }
    }

    // --- 422: new FormId already in use ---

    [Fact]
    public void Renumber_NewFormIdAlreadyInUse_ReturnsFormIdInUse()
    {
        FormKey kw1Key = default;
        FormKey kw2Key = default;
        var data = new PluginFixtureBuilder("rn-id-in-use")
            .WithPlugin("Source.esp", mod =>
            {
                kw1Key = mod.Keywords.AddNew().FormKey;
                kw2Key = mod.Keywords.AddNew().FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Try to renumber kw1 to have the same ID as kw2
                var result = orchestrator.Renumber(kw1Key.ToString(), kw2Key.ID, "Source.esp", "user");

                Assert.IsType<RenumberResult.FormIdInUse>(result);
            }
        }
    }

    // --- Successful renumber ---

    [Fact]
    public void Renumber_Success_StagesChangeGroupWithRenumberAndFieldEdits()
    {
        FormKey kwKey = default;
        FormKey npcKey = default;
        const uint newId = 0x999997;

        var data = new PluginFixtureBuilder("rn-success")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Editable.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReferencingNPC_RnSuccess");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.Renumber(kwKey.ToString(), newId, "Source.esp", "user");

                var staged = Assert.IsType<RenumberResult.Staged>(result);
                var group = staged.Group;
                Assert.Equal("renumber", group.Operation);

                var allChanges = changes.GetChanges(groupId: group.Id);

                // Exactly one renumber change for the record itself
                var renumberChange = Assert.Single(allChanges, c => c.ChangeType == "renumber");
                Assert.Equal(kwKey.ToString(), renumberChange.FormKey);
                Assert.Equal("Source.esp", renumberChange.Plugin);
                Assert.Equal("$renumber", renumberChange.FieldPath);
                Assert.Equal(kwKey.ToString(), renumberChange.OldValue.GetString());

                var expectedNewFormKey = $"{newId:X6}:Source.esp";
                Assert.Equal(expectedNewFormKey, renumberChange.NewValue.GetString());

                // One FieldEdit change updating the cross-plugin reference in Editable.esp
                var fieldEditChange = Assert.Single(allChanges, c => c.ChangeType == "field_edit");
                Assert.Equal(npcKey.ToString(), fieldEditChange.FormKey);
                Assert.Equal("Editable.esp", fieldEditChange.Plugin);
                Assert.Equal("npc_", fieldEditChange.RecordType);
                Assert.Equal("keywords", fieldEditChange.FieldPath);
                // New value should be an array containing the new FormKey
                var newKeywords = fieldEditChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                Assert.Contains(expectedNewFormKey, newKeywords, StringComparer.OrdinalIgnoreCase);
                Assert.DoesNotContain(kwKey.ToString(), newKeywords, StringComparer.OrdinalIgnoreCase);
            }
        }
    }

    [Fact]
    public void Renumber_IntraPluginReferenceNotStagedAsFieldEdit()
    {
        FormKey kwKey = default;
        FormKey npcKey = default;
        const uint newId = 0x999996;

        // Both keyword and NPC in the same plugin — intra-plugin reference handled by RemapLinks,
        // so no FieldEdit change should be staged.
        var data = new PluginFixtureBuilder("rn-intra-plugin")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew().FormKey;
                var npc = mod.Npcs.AddNew("IntraRefNPC_RnIntra");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.Renumber(kwKey.ToString(), newId, "Source.esp", "user");

                Assert.IsType<RenumberResult.Staged>(result);
                var allChanges = changes.GetChanges();
                // No FieldEdit — intra-plugin reference is handled by writer's RemapLinks
                Assert.DoesNotContain(allChanges, c => c.ChangeType == "field_edit");
                Assert.Single(allChanges, c => c.ChangeType == "renumber");
            }
        }
    }

    // --- plugin not in session ---

    [Fact]
    public void Renumber_TargetPluginNotInSession_StagesChange()
    {
        // When the specified plugin is absent from session.Plugins, pluginMeta is null.
        // The immutable check (null?.IsImmutable == true) is false, so we proceed.
        // This test verifies we don't throw, and that the change stages successfully.
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("rn-plugin-not-in-session")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.Renumber(kwKey.ToString(), 0x999998, "NonExistent.esp", "user");

                Assert.IsType<RenumberResult.Staged>(result);
            }
        }
    }

    // --- helpers ---

    private sealed class StubImmutableSessionManager : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;
        private readonly IGameSession? _stubSession;

        public StubImmutableSessionManager(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease,
            string immutablePlugin, SchemaReflector reflector, DuckDbPendingChangeService changes)
        {
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            _stubSession = new ImmutableOverrideSession(_inner.Session!, immutablePlugin);
        }

        public IGameSession? Session => _stubSession;
        public IRecordReader? Repository => _inner.Repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => _inner.SetFilter(sql);
        public void ClearFilter() => _inner.ClearFilter();
        public void Dispose() => _inner.Dispose();
    }

    private sealed class ImmutableOverrideSession : IGameSession
    {
        private readonly IGameSession _inner;
        private readonly IReadOnlyList<PluginMetadata> _plugins;

        public ImmutableOverrideSession(IGameSession inner, string immutablePlugin)
        {
            _inner = inner;
            _plugins = inner.Plugins
                .Select(p => p.Name.Equals(immutablePlugin, StringComparison.OrdinalIgnoreCase)
                    ? p with { IsImmutable = true }
                    : p)
                .ToList();
        }

        public string DataFolderPath => _inner.DataFolderPath;
        public GameRelease GameRelease => _inner.GameRelease;
        public IReadOnlyList<PluginMetadata> Plugins => _plugins;
        public Mutagen.Bethesda.Plugins.Cache.ILinkCache LinkCache => _inner.LinkCache;
        public string? FilterSql { get => _inner.FilterSql; set => _inner.FilterSql = value; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName) => _inner.GetMod(pluginName);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public void Dispose() { }
    }
}
