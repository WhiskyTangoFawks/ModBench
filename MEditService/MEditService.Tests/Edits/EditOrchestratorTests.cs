using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

public sealed class EditOrchestratorTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static DuckDbPendingChangeService MakePendingChangeService()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return new DuckDbPendingChangeService(conn);
    }

    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
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
            var changes = MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
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
            var changes = MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes);

            var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Source.esp", "user");

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("Source.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void StageEdit_PluginNotInSession_DoesNotThrow()
    {
        // Mutant 99: FirstOrDefault → First would throw when plugin is absent from session.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-plugin-absent")
            .WithPlugin("Present.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                // "Ghost.esp" is not in session.Plugins — must not throw
                var result = orchestrator.StageEdit(npcKey.ToString(), "Ghost.esp", fields, "user", null);

                // Plugin not found → treated as mutable, proceeds until RecordNotFound or Staged
                // (formKey exists under Present.esp, not Ghost.esp, so GetRecordForPlugin returns null → oldValues empty → Staged)
                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_NullCurrentRecord_OldValuesEmpty()
    {
        // Mutant 107: currentRecord != null → currentRecord == null would populate oldValues from null, crashing.
        // When GetRecordForPlugin returns null, oldValues must stay empty (OldValue is null for the staged change).
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-null-record")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                // Target.esp has no record for npcKey, so GetRecordForPlugin returns null
                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                // OldValue should be null (not populated) because currentRecord was null
                Assert.All(staged.Changes, c => Assert.Equal(JsonValueKind.Null, c.OldValue.ValueKind));
            }
        }
    }

    [Fact]
    public void StageEdit_OldValuesOnlyContainsEditedFields()
    {
        // Mutant 110: fields.ContainsKey negated → would capture fields NOT being edited instead of fields being edited.
        // A record with fields A, B, C; edit only A → OldValue is set only for A, not B or C.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-old-values-filter")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npc.Confidence = Npc.ConfidenceType.Brave;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                // Only edit "aggression"; "confidence" is in the record but not in the edit
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Unaggressive\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                var aggressionChange = Assert.Single(staged.Changes, c => c.FieldPath == "aggression");
                // OldValue must be the real prior value (not null) because "aggression" IS in the edit fields
                Assert.NotEqual(JsonValueKind.Null, aggressionChange.OldValue.ValueKind);
                // There must be no staged change for "confidence" (only aggression was edited)
                Assert.DoesNotContain(staged.Changes, c => c.FieldPath == "confidence");
            }
        }
    }

    [Fact]
    public void CopyRecordTo_TargetPluginNotInSession_DoesNotThrow()
    {
        // Mutant 113: FirstOrDefault → First in CopyRecordTo would throw when targetPlugin is absent.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-plugin-absent")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // "Ghost.esp" is not in session.Plugins — must not throw
                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Ghost.esp", "user");

                // Plugin absent → treated as mutable, proceeds → Staged
                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ExistingTargetRecord_CapturesOldValues()
    {
        // Mutant 119: NoCoverage — the branch capturing oldValues from the existing target record was never exercised.
        // Set up: npcKey exists in both Source.esp (Frenzied) and Target.esp (override, Aggressive).
        // CopyRecordTo should populate oldValues from the target's existing record.
        FormKey npcKey = default;

        // Build Source.esp first to capture npcKey, then build Target.esp as an override
        var dataFolder = Path.Combine(Path.GetTempPath(), $"eo-copy-existing-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataFolder);

        var sourceMod = new Fallout4Mod(ModKey.FromFileName("Source.esp"), Fallout4Release.Fallout4);
        var sourceNpc = sourceMod.Npcs.AddNew("TestNPC");
        sourceNpc.Aggression = Npc.AggressionType.Frenzied;
        npcKey = sourceNpc.FormKey;
        sourceMod.WriteToBinary(Path.Combine(dataFolder, "Source.esp"));

        // Target.esp overrides the same NPC with a different aggression
        var targetMod = new Fallout4Mod(ModKey.FromFileName("Target.esp"), Fallout4Release.Fallout4);
        var targetOverrideNpc = targetMod.Npcs.GetOrAddAsOverride(sourceNpc);
        targetOverrideNpc.Aggression = Npc.AggressionType.Aggressive;
        targetMod.WriteToBinary(Path.Combine(dataFolder, "Target.esp"));

        var pluginsTxtPath = Path.Combine(dataFolder, "Plugins.txt");
        File.WriteAllText(pluginsTxtPath, "*Source.esp\n*Target.esp\n");

        var fixtureData = new PluginFixtureData(dataFolder, pluginsTxtPath);
        using (fixtureData)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(dataFolder, pluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                // At least one change should have a non-null OldValue (populated from existing target record)
                Assert.Contains(staged.Changes, c => c.OldValue.ValueKind != JsonValueKind.Null);
            }
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
        private readonly IGameSession? _stubSession;

        public StubSessionManagerWithImmutablePlugin(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease, string immutablePlugin)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
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
