using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

public sealed class EditOrchestratorTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector));
        var changes = new PendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes);
        return (orchestrator, manager);
    }

    // --- StageEdit ---

    [Fact]
    public void StageEdit_ValidEdit_StagesChange()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-valid-edit")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Single(staged.Changes);
                Assert.Equal("aggression", staged.Changes[0].FieldPath);
            }
        }
    }

    [Fact]
    public void StageEdit_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-not-found")
            .WithPlugin("TestPlugin.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit("FFFFFF:NoSuch.esp", "TestPlugin.esp", fields, "user", null);

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_ImmutablePlugin_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-immutable")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            // Use a stub session that marks the plugin as immutable
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "TestPlugin.esp");

            var reflector = new SchemaReflector();
            var changes = new PendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes);

            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("TestPlugin.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void StageEdit_ReadOnlyField_ReturnsReadOnlyFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-readonly")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["form_key"] = J("\"anything\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var readOnly = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
                Assert.Contains("form_key", readOnly.Fields);
            }
        }
    }

    [Fact]
    public void StageEdit_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit("ABC:000001:X.esp", "X.esp", fields, "user", null);

            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }

    // --- CopyRecordTo ---

    [Fact]
    public void CopyRecordTo_ValidCopy_StagesAllWinnerFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-to")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                Assert.All(staged.Changes, c => Assert.Equal("Target.esp", c.Plugin));
            }
        }
    }

    [Fact]
    public void CopyRecordTo_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-copy-notfound")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo("FFFFFF:NoSuch.esp", "Target.esp", "user");

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ImmutableTarget_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-immutable")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "Source.esp");

            var reflector = new SchemaReflector();
            var changes = new PendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes);

            var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Source.esp", "user");

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("Source.esp", immutable.Plugin);
        }
    }

    // --- helpers ---

    /// <summary>
    /// Wraps a real SessionManager but overrides one plugin's IsImmutable to true.
    /// Used to test immutability enforcement without needing actual base-game files.
    /// </summary>
    private sealed class StubSessionManagerWithImmutablePlugin : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;
        private readonly string _immutablePlugin;
        private IGameSession? _stubSession;

        public StubSessionManagerWithImmutablePlugin(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease, string immutablePlugin)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector));
            _immutablePlugin = immutablePlugin;
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            _stubSession = new ImmutableOverrideSession(_inner.Session!, immutablePlugin);
        }

        public IGameSession? Session => _stubSession;
        public IRecordReader? Repository => _inner.Repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();

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
        public ILinkCache LinkCache => _inner.LinkCache;
        public IModGetter? GetMod(string pluginName) => _inner.GetMod(pluginName);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public void Dispose() { } // inner managed by StubSessionManagerWithImmutablePlugin
    }
}
