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
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

[Collection(TestPluginFixtureCollection.Name)]
public class SessionManagerTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static SessionManager MakeManager(IModImporter? modImporter = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory,
            modImporter: modImporter);
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new SessionManager(spy);

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

        var count = manager.Repository!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName, "Data");

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
    public void Unload_ClearsReferencesAndDisposesRepository()
    {
        using var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var oldRepo = manager.Repository;
        manager.Unload();

        Assert.Null(manager.Session);
        Assert.Null(manager.Repository);
        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName, "Data"));
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




    // --- CreatePlugin ---

    [Fact]
    public void CreatePlugin_UpdatesSessionState()
    {
        var data = new PluginFixtureBuilder("cp-state")
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("ExistingNPC"))
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var repositoryBefore = manager.Repository;

            manager.CreatePlugin("NewPlugin.esp");

            Assert.Same(repositoryBefore, manager.Repository);
            Assert.Contains(manager.Session!.Plugins, p => p.Name == "NewPlugin.esp");
            Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "Base.esp", "Data"));
            Assert.Contains("*NewPlugin.esp", File.ReadAllText(data.PluginsTxtPath));
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
            .WithPlugin("Full.esp", mod => mod.ModHeader.Stats.NextFormID = 0x1000000u,
                writeParams: new BinaryWriteParameters { NextFormID = NextFormIDOption.NoCheck })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            Assert.Throws<InvalidOperationException>(() => manager.ReserveFormKey("Full.esp"));
        }
    }

    [Fact]
    public void ReserveFormKey_AtMaxValidFormId_Succeeds()
    {
        var data = new PluginFixtureBuilder("fk-max")
            .WithPlugin("Max.esp", mod => mod.ModHeader.Stats.NextFormID = 0xFFFFFFu,
                writeParams: new BinaryWriteParameters { NextFormID = NextFormIDOption.NoCheck })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var fk = manager.ReserveFormKey("Max.esp");

            Assert.True(FormKey.TryFactory(fk, out var parsed));
            Assert.Equal(0xFFFFFFu, parsed.ID);
        }
    }

    [Fact]
    public void ReserveFormKey_FreshlyCreatedEmptyPlugin_NeverReturnsFormIdZero()
    {
        // FormID 0 is reserved: Issue #1's plugin-header record lives at the synthetic FormKey
        // `000000:<plugin>`. A freshly-activated Mutagen mod (ModFactory.Activator, used by
        // CreatePlugin) reports NextFormID == 0 before any record has ever been added, so a naive
        // reservation would collide with that plugin's own header row.
        var data = new PluginFixtureBuilder("fk-fresh-zero").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            manager.CreatePlugin("BrandNew.esp");

            var fk = manager.ReserveFormKey("BrandNew.esp");

            Assert.True(FormKey.TryFactory(fk, out var parsed));
            Assert.NotEqual(0u, parsed.ID);
        }
    }

    [Fact]
    public void ReserveFormKey_LoadedEmptyPluginWithZeroNextFormId_NeverReturnsFormIdZero()
    {
        // A plugin with no records ever added and never explicitly given a NextFormID (as
        // PluginFixtureBuilder.WithPlugin("Empty.esp") produces) round-trips through
        // WriteToBinary + Load with a literal NextFormID of 0 in its on-disk header. Issue #1's
        // header record occupies FormID 0 for every plugin, so Load must floor the reservation
        // counter at the game's recommended minimum rather than trusting a raw 0 from disk.
        var data = new PluginFixtureBuilder("fk-loaded-zero").WithPlugin("Empty.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var fk = manager.ReserveFormKey("Empty.esp");

            Assert.True(FormKey.TryFactory(fk, out var parsed));
            Assert.NotEqual(0u, parsed.ID);
        }
    }

    [Fact]
    public void ReserveFormKey_SequentialCalls_ReturnConsecutiveIds()
    {
        using var manager = MakeLoadedManager();

        var fk1 = manager.ReserveFormKey(TestPluginFixture.PluginName);
        var fk2 = manager.ReserveFormKey(TestPluginFixture.PluginName);

        Assert.True(FormKey.TryFactory(fk1, out var parsed1));
        Assert.True(FormKey.TryFactory(fk2, out var parsed2));
        Assert.Equal(parsed1.ID + 1, parsed2.ID);
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

    private sealed class SpyRepositoryFactory(IRecordRepositoryFactory inner) : IRecordRepositoryFactory
    {
        private readonly IRecordRepositoryFactory _inner = inner;
        public int CreateCallCount { get; private set; }
        public GameRelease? LastGameRelease { get; private set; }

        public IRecordRepository Create(GameRelease gameRelease)
        {
            CreateCallCount++;
            LastGameRelease = gameRelease;
            return _inner.Create(gameRelease);
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
        var data = new PluginFixtureBuilder("cp-esm").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var result = manager.CreatePlugin("NewMaster.esm");

            Assert.Equal("NewMaster.esm", result.Name);
            Assert.True(result.IsMaster);
        }
    }

    [Fact]
    public void CreatePlugin_EslExtension_IsAccepted()
    {
        var data = new PluginFixtureBuilder("cp-esl").WithPlugin("Base.esp").Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            var result = manager.CreatePlugin("NewLight.esl");

            Assert.Equal("NewLight.esl", result.Name);
            Assert.True(result.IsLight);
        }
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
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName, "Data"));
    }


    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var manager = MakeManager();
        manager.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        var oldRepo = manager.Repository;

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName, "Data"));
    }

    // --- ReindexPlugins ---

    [Fact]
    public async Task ReindexPlugins_DisposesLoadedMods()
    {
        var data = new PluginFixtureBuilder("reindex-dispose")
            .WithPlugin("Plugin.esp", mod => mod.Npcs.AddNew("DisposeNPC"))
            .Build();
        using (data)
        {
            var spy = new SpyModImporter();
            using var manager = MakeManager(modImporter: spy);
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            await manager.ReindexPlugins(["Plugin.esp"]);

            Assert.NotEmpty(spy.LoadedMods);
            Assert.All(spy.LoadedMods, m =>
            {
                Assert.True(m.IsDisposed);
                Assert.NotNull(m.Getter);
            });
        }
    }

    [Fact]
    public async Task ReindexPlugins_AfterBinaryChange_UpdatesRepositoryAndWinners()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-plugins-batch")
            .WithPlugin("Plugin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("BatchReindexNPC");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            using var manager = MakeManager();
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

            // #410: the binary changes underneath the session with nothing in Modbench told about
            // it — written straight through Mutagen, which is also the shape the never-assume-
            // exclusive-ownership rule cares about (xEdit or MO2 rewriting the file between reads).
            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).Aggression = Npc.AggressionType.Frenzied;
            manager.Session!.GetMod("Plugin.esp", "Data");
            onDisk.WriteToBinary(pluginPath);

            await manager.ReindexPlugins(["Plugin.esp"]);

            var detail = manager.Repository!.GetRecord("npc_", npcKey.ToString(), "Plugin.esp", "Data", winnerOnly: false)!;
            var aggressionValue = detail.Fields.First(f => f.Metadata.Name == "aggression").Value?.ToString();
            Assert.Equal("Frenzied", aggressionValue);
            Assert.True(detail.IsWinner);
        }
    }

    [Fact]
    public async Task ReindexPlugins_EmptyList_Succeeds()
    {
        using var manager = MakeLoadedManager();
        var ex = await Record.ExceptionAsync(() => manager.ReindexPlugins([]));
        Assert.Null(ex);
    }

    // --- Load disposes previous session ---

    // --- helpers ---

    private SessionManager MakeLoadedManager()
    {
        var m = MakeManager();
        m.Load(_fixture.DataFolder, _fixture.PluginsTxtPath, GameRelease.Fallout4);
        return m;
    }

    private sealed class SpyModImporter : IModImporter
    {
        private readonly List<SpyLoadedMod> _mods = [];
        public IReadOnlyList<SpyLoadedMod> LoadedMods => _mods;

        public ILoadedMod Import(ModPath modPath, GameRelease gameRelease)
        {
            var real = ModFactory.ImportGetter(modPath, gameRelease);
            var spy = new SpyLoadedMod(real);
            _mods.Add(spy);
            return spy;
        }
    }

    private sealed class SpyLoadedMod(IModDisposeGetter inner) : ILoadedMod
    {
        public bool IsDisposed { get; private set; }
        public IModGetter Getter => inner;
        public void Dispose() { IsDisposed = true; inner.Dispose(); }
    }
}
