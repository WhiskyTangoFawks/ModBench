using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
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
            J("null"), J(json), "user", null, DateTime.UtcNow);

    private static SessionManager MakeManager()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector), new FieldMetadataMapper());
        return new SessionManager(factory, new PluginWriter(reflector));
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var reflector = new SchemaReflector();
        var inner = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector), new FieldMetadataMapper());
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new SessionManager(spy, new PluginWriter(reflector));

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
            var schema = new SchemaReflector().GetSchemas(GameRelease.Fallout4)["npc_"];
            var change = MakePendingChange(npcKey.ToString(), "TestPlugin.esp", "aggression", "npc_", "\"Frenzied\"");

            await manager.SavePlugin("TestPlugin.esp", [change]);

            var detail = manager.Repository!.GetRecord("npc_", schema, npcKey.ToString(), "TestPlugin.esp", winnerOnly: false)!;
            var aggressionValue = detail.Fields.First(f => f.Metadata.Name == "aggression").Value?.ToString();
            Assert.Equal("Frenzied", aggressionValue);
        }
    }
}
