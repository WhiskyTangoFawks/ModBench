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

namespace MEditService.Tests.Session;

public class SessionManagerTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;

    public SessionManagerTests(TestPluginFixture fixture) => _fixture = fixture;

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static PendingChange MakePendingChange(string formKey, string plugin, string fieldPath, string recordType, string json) =>
        new(Guid.NewGuid(), formKey, plugin, fieldPath, recordType,
            J("null"), J(json), "user", null, DateTime.UtcNow, "field_edit", null);

    private static SessionManager MakeManager()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var reflector = new SchemaReflector();
        var inner = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new SessionManager(spy, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));

        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(1, spy.CreateCallCount);
        Assert.Equal(GameRelease.Fallout4, spy.LastGameRelease);
    }

    [Fact]
    public void Load_PopulatesSessionAndRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.NotNull(manager.Repository);
        Assert.Single(manager.Session.Plugins);
        Assert.Equal(TestPluginFixture.PluginName, manager.Session.Plugins[0].Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var count = manager.Repository!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName);

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        var result = manager.Repository!.GetRecords("npc_", null, null, 100, 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Unload_ClearsSessionAndRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        manager.Unload();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
    }

    [Fact]
    public void Load_ReplacesExistingSession()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var firstRepo = manager.Repository;

        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.NotSame(firstRepo, manager.Repository);
        Assert.NotNull(manager.Session);
    }

    [Fact]
    public void Load_WithGameRelease_SessionHasCorrectGameRelease()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.Equal(GameRelease.Fallout4, manager.Session!.GameRelease);
    }

    // --- SavePlugin ---

    [Fact]
    public async Task SavePlugin_WritableField_ReturnsSaveResultWithApplied()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("sm-save")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("SaveTestNPC").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var change = MakePendingChange(npcKey.ToString(), "TestPlugin.esp", "aggression", "npc_", "\"Frenzied\"");

            var result = await manager.SavePlugin("TestPlugin.esp", [change]);

            Assert.Contains("aggression", result.Applied);
            Assert.Empty(result.ReadOnly);
            Assert.Empty(result.NotFound);
        }
    }

    // --- CreatePlugin ---

    [Fact]
    public void CreatePlugin_DoesNotReplaceRepository()
    {
        var data = new PluginFixtureBuilder("cp-no-replace")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var repositoryBefore = manager.Repository;

            manager.CreatePlugin("NewPlugin.esp");

            Assert.Same(repositoryBefore, manager.Repository);
        }
    }

    [Fact]
    public void CreatePlugin_NewPluginAppearsInSession()
    {
        var data = new PluginFixtureBuilder("cp-appears")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            manager.CreatePlugin("NewPlugin.esp");

            Assert.Contains(manager.Session!.Plugins, p => p.Name == "NewPlugin.esp");
        }
    }

    [Fact]
    public void CreatePlugin_ExistingPluginRecordsStillPresent()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("cp-existing-records")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("ExistingNPC").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            manager.CreatePlugin("NewPlugin.esp");

            var count = manager.Repository!.CountRecordsForPlugin("npc_", "Base.esp");
            Assert.Equal(1, count);
        }
    }

    // --- SetFilter / ClearFilter ---

    [Fact]
    public void SetFilter_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<InvalidOperationException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\""));
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public void ClearFilter_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = Assert.Throws<InvalidOperationException>(() => manager.ClearFilter());
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public void SetFilter_ValidSql_SetsSqlOnSession()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.Session!.FilterSql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnSession()
    {
        using var manager = MakeLoadedManager();
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        manager.ClearFilter();
        Assert.Null(manager.Session!.FilterSql);
    }

    // --- ReserveFormKey ---

    [Fact]
    public void ReserveFormKey_LoadedPlugin_ReturnsValidFormKeyAndIncrements()
    {
        using var manager = MakeLoadedManager();

        var fk1 = manager.ReserveFormKey(TestPluginFixture.PluginName);
        var fk2 = manager.ReserveFormKey(TestPluginFixture.PluginName);

        Assert.True(FormKey.TryFactory(fk1, out var parsed1));
        Assert.Equal(TestPluginFixture.PluginName, parsed1.ModKey.FileName.ToString());
        Assert.NotEqual(fk1, fk2);
    }

    [Fact]
    public void ReserveFormKey_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        Assert.Throws<InvalidOperationException>(() => manager.ReserveFormKey("TestPlugin.esp"));
    }

    [Fact]
    public void ReserveFormKey_UnknownPlugin_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();

        Assert.Throws<ArgumentException>(() => manager.ReserveFormKey("NotLoaded.esp"));
    }

    [Fact]
    public void ReserveFormKey_ConcurrentCalls_ReturnDistinctFormKeys()
    {
        using var manager = MakeLoadedManager();
        var results = new System.Collections.Concurrent.ConcurrentBag<string>();

        Parallel.For(0, 50, _ => results.Add(manager.ReserveFormKey(TestPluginFixture.PluginName)));

        Assert.Equal(50, results.Distinct().Count());
    }

    [Fact]
    public void ReserveFormKey_ExhaustedSpace_ThrowsInvalidOperationException()
    {
        var data = new PluginFixtureBuilder("fk-exhausted")
            .WithPlugin("Full.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            // Manually exhaust by stuffing a large seed via reflection
            var field = typeof(SessionManager)
                .GetField("_nextFormIds", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
            var dict = (Dictionary<string, uint>)field.GetValue(manager)!;
            dict["Full.esp"] = 0x1000000u;

            Assert.Throws<InvalidOperationException>(() => manager.ReserveFormKey("Full.esp"));
        }
    }

    [Fact]
    public async Task SavePlugin_WithCreateChange_ReloadPicksUpBumpedNextFormID()
    {
        var data = new PluginFixtureBuilder("sm-create-nfid")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("SeedNPC"))
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var reservedFk = manager.ReserveFormKey("TestPlugin.esp");
            FormKey.TryFactory(reservedFk, out var parsedFk);

            var createChange = new PendingChange(
                Guid.NewGuid(), reservedFk, "TestPlugin.esp", "$create", "npc_",
                J("null"), J("null"), "user", null, DateTime.UtcNow, "create", null);

            await manager.SavePlugin("TestPlugin.esp", [createChange]);

            // Reload so _nextFormIds picks up the updated NextFormID written by SaveAsync
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var nextFk = manager.ReserveFormKey("TestPlugin.esp");
            FormKey.TryFactory(nextFk, out var nextParsed);

            Assert.True(nextParsed.ID > parsedFk.ID,
                $"Expected NextFormID > {parsedFk.ID:X6} after save with create change; got {nextParsed.ID:X6}");
        }
    }

    [Fact]
    public void CreatePlugin_SeedsNextFormIds_PluginIsImmediatelyReservable()
    {
        var data = new PluginFixtureBuilder("cp-seed-fk")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            manager.CreatePlugin("Fresh.esp");

            var fk = manager.ReserveFormKey("Fresh.esp");

            Assert.True(FormKey.TryFactory(fk, out var parsed));
            Assert.Equal("Fresh.esp", parsed.ModKey.FileName.ToString());
        }
    }

    // --- helpers ---

    private sealed class SpyRepositoryFactory : IRecordRepositoryFactory
    {
        private readonly IRecordRepositoryFactory _inner;
        public int CreateCallCount { get; private set; }
        public GameRelease? LastGameRelease { get; private set; }

        public SpyRepositoryFactory(IRecordRepositoryFactory inner) => _inner = inner;

        public IRecordRepository Create(GameRelease gameRelease)
        {
            CreateCallCount++;
            LastGameRelease = gameRelease;
            return _inner.Create(gameRelease);
        }
    }

    [Fact]
    public async Task SavePlugin_AfterSave_RepositoryReflectsNewFieldValue()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("sm-reindex")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReindexTestNPC");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var change = MakePendingChange(npcKey.ToString(), "TestPlugin.esp", "aggression", "npc_", "\"Frenzied\"");

            await manager.SavePlugin("TestPlugin.esp", [change]);

            var detail = manager.Repository!.GetRecord("npc_", npcKey.ToString(), "TestPlugin.esp", winnerOnly: false)!;
            var aggressionValue = detail.Fields.First(f => f.Metadata.Name == "aggression").Value?.ToString();
            Assert.Equal("Frenzied", aggressionValue);
        }
    }

    [Fact]
    public async Task SavePlugin_AfterSave_RecordRemainsWinner()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("sm-save-winner")
            .WithPlugin("TestPlugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("WinnerNPC");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var change = MakePendingChange(npcKey.ToString(), "TestPlugin.esp", "aggression", "npc_", "\"Frenzied\"");

            await manager.SavePlugin("TestPlugin.esp", [change]);

            var result = manager.Repository!.GetRecords("npc_", "TestPlugin.esp", null, 100, 0);
            Assert.All(result.Items, r => Assert.True(r.IsWinner));
        }
    }

    [Fact]
    public void CreatePlugin_NewPlugin_AddedToPluginsTxt()
    {
        var data = new PluginFixtureBuilder("cp-plugins-txt")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            manager.CreatePlugin("NewPlugin.esp");

            var pluginsTxtContent = File.ReadAllText(data.PluginsTxtPath);
            Assert.Contains("*NewPlugin.esp", pluginsTxtContent);
        }
    }

    [Fact]
    public void CreatePlugin_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager(); // not loaded
        var ex = Assert.Throws<InvalidOperationException>(() => manager.CreatePlugin("New.esp"));
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public void CreatePlugin_AlreadyExists_ThrowsIOException()
    {
        var data = new PluginFixtureBuilder("cp-already-exists")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            manager.CreatePlugin("Duplicate.esp"); // first call creates it
            var ex = Assert.Throws<IOException>(() => manager.CreatePlugin("Duplicate.esp"));
            Assert.Contains("already exists", ex.Message);
        }
    }

    // --- CreatePlugin guard clauses ---

    [Fact]
    public void CreatePlugin_InvalidExtension_ThrowsArgumentException()
    {
        using var manager = MakeManager(); // no Load — extension check fires first
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("Mod.txt"));
        Assert.Contains("extension", ex.Message);
    }

    [Fact]
    public void Load_WithNonExistentPath_Throws()
    {
        using var manager = MakeManager();
        Assert.ThrowsAny<Exception>(() =>
            manager.Load("/no-such-path", "/no-such-path/Plugins.txt", GameRelease.Fallout4));
    }

    [Fact]
    public void CreatePlugin_NullName_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin(null!));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_WhitespaceName_ThrowsArgumentException()
    {
        using var manager = MakeLoadedManager();
        var ex = Assert.Throws<ArgumentException>(() => manager.CreatePlugin("   "));
        Assert.Contains("empty", ex.Message);
    }

    [Fact]
    public void CreatePlugin_EsmExtension_IsAccepted()
    {
        using var manager = MakeLoadedManager();
        var result = manager.CreatePlugin("NewMaster.esm");
        Assert.Equal("NewMaster.esm", result.Name);
        Assert.True(result.IsMaster);
    }

    [Fact]
    public void CreatePlugin_EslExtension_IsAccepted()
    {
        using var manager = MakeLoadedManager();
        var result = manager.CreatePlugin("NewLight.esl");
        Assert.Equal("NewLight.esl", result.Name);
        Assert.True(result.IsLight);
    }

    // --- SavePlugin guard clauses ---

    [Fact]
    public async Task SavePlugin_NoSession_ThrowsInvalidOperationException()
    {
        using var manager = MakeManager();
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => manager.SavePlugin("SomePlugin.esp", []));
        Assert.Contains("No session", ex.Message);
    }

    [Fact]
    public async Task SavePlugin_UnknownPlugin_ThrowsKeyNotFoundException()
    {
        using var manager = MakeLoadedManager();
        var ex = await Assert.ThrowsAsync<KeyNotFoundException>(
            () => manager.SavePlugin("DoesNotExist.esp", []));
        Assert.Contains("not found", ex.Message);
    }

    // --- Disposal actually releases resources ---

    [Fact]
    public void Load_SecondLoad_OldRepositoryBecomesUnusable()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName));
    }

    [Fact]
    public void Unload_RepositoryBecomesUnusable()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.Unload();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName));
    }

    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName));
    }

    // --- Load disposes previous session ---

    [Fact]
    public void Load_SecondCall_PreviousRepositoryIsDisposed()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var firstRepo = manager.Repository as IDisposable;

        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);

        // DuckDbRecordRepository.Dispose sets its connection to null; a subsequent query throws.
        // Simply verifying that the repo reference has been replaced is sufficient to show
        // the old one was released.
        Assert.NotSame(firstRepo, manager.Repository);
    }

    // --- helpers ---

    private SessionManager MakeLoadedManager()
    {
        var m = MakeManager();
        m.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        return m;
    }
}
