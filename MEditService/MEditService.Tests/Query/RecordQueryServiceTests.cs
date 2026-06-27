using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Query;

public sealed class RecordQueryServiceTests : IClassFixture<TestPluginFixture>, IDisposable
{
    private readonly SessionManager _manager;
    private readonly RecordQueryService _svc;

    public RecordQueryServiceTests(TestPluginFixture fixture)
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        _manager.Load(fixture.DataFolder, fixture.PluginsTxtPath, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
        Assert.Equal(TestPluginFixture.RecordCount, plugins[0].RecordCount);
    }

    // --- GET /record-types ---

    [Fact]
    public void GetRecordTypes_ReturnsKnownTypes()
    {
        var types = _svc.GetRecordTypes();

        Assert.Contains("npc_", types);
        Assert.Contains("weap", types);
        Assert.True(types.Count >= 20);
    }

    [Fact]
    public void GetRecordTypes_ReturnsTypesInAscendingOrder()
    {
        var types = _svc.GetRecordTypes();
        Assert.Equal(types.Order().ToList(), types);
    }

    // --- GET /records ---

    [Fact]
    public void GetRecords_ByType_ReturnsPaginatedResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_SearchByEditorId_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 10, offset: 0);

        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void GetRecords_ByPlugin_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsCombinedResults()
    {
        var result = _svc.GetRecords(type: null, plugin: null, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        var page1 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 0);
        var page2 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 1);

        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // --- GET /records/{formKey} ---

    [Fact]
    public void GetRecord_ReturnsWinnerWithFields()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecord(fk);

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.True(detail.IsWinner);
        Assert.NotEmpty(detail.Fields);
    }

    [Fact]
    public void GetRecord_FieldsHaveMetadata()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var detail = _svc.GetRecord(all.Items[0].FormKey)!;

        Assert.All(detail.Fields, f =>
        {
            Assert.NotEmpty(f.Metadata.Name);
            Assert.Contains(f.Metadata.Type, new[] { "string", "int", "float", "bool", "enum", "formKey", "array", "struct" });
        });
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecord("FFFFFF:Unknown.esp");

        Assert.Null(detail);
    }

    // --- GET /records/{formKey}/compare ---

    [Fact]
    public void GetCompare_SingleOverride_ReturnsDiffs()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.Single(compare.Overrides);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.NotEmpty(compare.Diffs);
    }

    [Fact]
    public void GetCompare_RecordIdenticalExceptVmad_ClassifiesAsConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-conflict")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20))
            .WithPlugin("Top.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(30))
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var compare = svc.GetCompare(npcKey.ToString());

            Assert.NotNull(compare);
            // Non-VMAD fields are identical overrides, so only VMAD differs — yet the record is conflicted.
            Assert.Equal(ConflictAll.Conflict, compare!.ConflictAll);
            Assert.NotNull(compare.Vmad);
            var script = Assert.Single(compare.Vmad!.Scripts);
            var prop = script.Properties.First(p => p.Name == "Power");
            Assert.Equal("Top.esp", prop.WinnerPlugin);
        }
    }

    [Fact]
    public void GetCompare_NoOverrideHasVmad_VmadIsNull()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.Null(compare!.Vmad);
    }

    [Fact]
    public void GetCompare_OnlyOverrideHasVmad_PopulatesVmad()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-added")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("PlainNpc").FormKey) // no VMAD
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(5))
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(npcKey.ToString());
                Assert.NotNull(compare);
                Assert.NotNull(compare!.Vmad); // master lacks VMAD, override adds it → still present
                Assert.Equal(ConflictAll.Override, compare.ConflictAll);
            });
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadOverride_StaysOverride()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-field-override")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Over.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Changed";           // generic field override
                o.VirtualMachineAdapter = ScriptVmad(20); // VMAD override (2 plugins)
            })
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Override, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadConflict_EscalatesToConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-field-conflict")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Same";              // non-masters agree on the field → generic Override
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Same";
                o.VirtualMachineAdapter = ScriptVmad(30); // VMAD differs among non-masters → Conflict
            })
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Conflict, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_UncontestedFieldOverrideWithVmadConflict_EscalatesToConflict()
    {
        // Verifies EscalateConflict(Override, Conflict) = Conflict (not Override).
        // Both Mid and Top set aggression to the same non-master value → generic = Override (not Conflict).
        // But their VMAD values differ → vmad = Conflict.
        // So EscalateConflict(Override, Conflict) must return Conflict.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-escalate-override")
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EscalateTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // both non-masters agree on Frenzied → Override
                o.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // same as Mid → no generic conflict
                o.VirtualMachineAdapter = ScriptVmad(20); // differs from Mid → VMAD Conflict
            })
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Conflict, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    private static void WithCompareService(PluginFixtureData data, Action<RecordQueryService> test)
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        test(new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier()));
    }

    private static FormKey MakeScriptedNpc(IFallout4Mod mod, int power)
    {
        var npc = mod.Npcs.AddNew("ScriptedNPC");
        npc.VirtualMachineAdapter = ScriptVmad(power);
        return npc.FormKey;
    }

    private static VirtualMachineAdapter ScriptVmad(int power)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptIntProperty { Name = "Power", Data = power });
        vmad.Scripts.Add(script);
        return vmad;
    }

    [Fact]
    public void GetCompare_UnknownFormKey_ReturnsNull()
    {
        var compare = _svc.GetCompare("FFFFFF:Unknown.esp");

        Assert.Null(compare);
    }

    // --- GET /plugins/{plugin}/record-types ---

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, npc.Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void GetPluginRecordTypes_ReturnsTypesInAscendingOrder()
    {
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);
        var types = result.Select(r => r.Type).ToList();
        Assert.Equal(types.Order().ToList(), types);
    }

    [Fact]
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        var result = _svc.GetPluginRecordTypes("DoesNotExist.esp");

        Assert.Empty(result);
    }

    // --- GET /records?type=unknown ---

    [Fact]
    public void GetRecords_UnknownType_ReturnsEmptyPagedResult()
    {
        var result = _svc.GetRecords(type: "xxxx", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    // --- GET /records/{formKey}/plugin/{plugin} ---

    [Fact]
    public void GetRecordForPlugin_KnownFormKey_ReturnsRecord()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.Equal(TestPluginFixture.PluginName, detail.Plugin);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecordForPlugin("FFFFFF:Unknown.esp", TestPluginFixture.PluginName);

        Assert.Null(detail);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownPlugin_ReturnsNull()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, "NonExistent.esp");

        Assert.Null(detail);
    }

    // --- GET /records/{formKey}/type ---

    [Fact]
    public void GetRecordType_KnownFormKey_ReturnsType()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var type = _svc.GetRecordType(fk);

        Assert.Equal("npc_", type);
    }

    [Fact]
    public void GetRecordType_UnknownFormKey_ReturnsNull()
    {
        var type = _svc.GetRecordType("FFFFFF:Unknown.esp");

        Assert.Null(type);
    }

    // --- GET /records/{formKey}/compare — with pending changes ---

    [Fact]
    public void GetCompare_WithPendingChanges_IncludesPendingFieldsInOverride()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        // Stage a pending change for this record
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var newVal = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement;
        changes.Upsert(fk, TestPluginFixture.PluginName, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = newVal },
            "test", null,
            new Dictionary<string, System.Text.Json.JsonElement>());

        var svcWithChanges = new RecordQueryService(_manager, changes, new SchemaReflector(), new ConflictClassifier());
        var compare = svcWithChanges.GetCompare(fk);

        Assert.NotNull(compare);
        var override_ = compare.Overrides.Single(o => o.Plugin == TestPluginFixture.PluginName);
        Assert.NotNull(override_.PendingFields);
        Assert.True(override_.PendingFields!.ContainsKey("aggression"));
    }

    // --- No-session guard clauses ---

    [Fact]
    public void GetPlugins_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetPlugins());
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsSortedByEditorId()
    {
        var data = new PluginFixtureBuilder("rqs-sort-records")
            .WithPlugin("SortTest.esp", mod =>
            {
                mod.Npcs.AddNew("Zebra");
                mod.Npcs.AddNew("Apple");
            })
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: null, plugin: null, search: null, limit: 10, offset: 0);

            var editorIds = result.Items.Select(r => r.EditorId).ToList();
            Assert.Equal(2, editorIds.Count);
            Assert.Equal(editorIds.OrderBy(e => e, StringComparer.OrdinalIgnoreCase).ToList(), editorIds);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_WithMultipleTypes_ReturnsInAscendingOrder()
    {
        var data = new PluginFixtureBuilder("rqs-sort-types")
            .WithPlugin("MultiType.esp", mod =>
            {
                mod.Npcs.AddNew("TestNPC");
                mod.Weapons.AddNew("TestWeapon");
            })
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("MultiType.esp");
            var types = result.Select(r => r.Type).ToList();

            Assert.True(types.Count >= 2, "Expected at least 2 record types");
            Assert.Equal(types.OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList(), types);
        }
    }

    private static RecordQueryService MakeUnloadedService()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        return new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    // --- GetRecord / GetRecordForPlugin use FindRecordType, not table scan ---

    private (RecordQueryService Svc, SpyRecordReader Spy, IDisposable Mod) MakeSpySvc()
    {
        var reflector = new SchemaReflector();
        var inner = new InMemoryRecordRepository(reflector);
        inner.Initialize(GameRelease.Fallout4);
        var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0);
        inner.UpdateWinners();
        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
        return (svc, spy, mod);
    }

    [Fact]
    public void GetRecord_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            spy.Reset();
            var detail = svc.GetRecord(fk);
            Assert.NotNull(detail);
            Assert.Equal(1, spy.FindRecordTypeCalls);
            Assert.Equal(1, spy.GetRecordCalls);
        }
    }

    [Fact]
    public void GetRecordForPlugin_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            spy.Reset();
            var detail = svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);
            Assert.NotNull(detail);
            Assert.Equal(1, spy.FindRecordTypeCalls);
            Assert.Equal(1, spy.GetRecordCalls);
        }
    }

    [Fact]
    public void GetRecord_PassesWinnerOnlyTrue()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            svc.GetRecord(fk);
            Assert.True(spy.LastWinnerOnly);
        }
    }

    [Fact]
    public void GetRecordForPlugin_PassesWinnerOnlyFalse()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName);
            Assert.False(spy.LastWinnerOnly);
        }
    }

    // --- GetPluginRecordTypes — staged records ---

    [Fact]
    public void GetPluginRecordTypes_IncludesStagedRecordsNotInIndex()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-types")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(1, npc.Count);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_StagedCountAddedToCommittedCount()
    {
        FormKey npcKey1 = default;
        FormKey npcKey2 = default;
        var data = new PluginFixtureBuilder("rqs-staged-types-merge")
            .WithPlugin("Source.esp", mod =>
            {
                npcKey1 = mod.Npcs.AddNew("NPC1").FormKey;
                npcKey2 = mod.Npcs.AddNew("NPC2").FormKey;
            })
            .WithPlugin("Override.esp", mod => mod.Npcs.AddNew("NPC1") /* commits one override */)
            .Build();
        using (data)
        {
            // Override.esp has 1 committed record; stage a 2nd one
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            // stage npcKey2 into Override.esp (not yet committed)
            changes.Upsert(npcKey2.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(2, npc.Count);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_StagedAlreadyCommittedRecordIsNotCounted()
    {
        // Override.esp has a committed NPC override that is NOT the winner (Winner.esp comes later).
        // Staging a pending edit to that committed key must not double-count it.
        FormKey baseNpcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-types-dedup")
            .WithPlugin("Base.esp", mod => baseNpcKey = mod.Npcs.AddNew("BaseNPC").FormKey)
            .WithPlugin("Override.esp", (mod, prev) => { mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).EditorID = "OverrideNPC"; })
            .WithPlugin("Winner.esp", (mod, prev) => { mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).EditorID = "WinnerNPC"; })
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(baseNpcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(1, npc.Count);
        }
    }

    // --- GetRecords — staged records ---

    [Fact]
    public void GetRecords_ByPlugin_IncludesStagedOnlyRecords()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-records")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: "npc_", plugin: "Override.esp", search: null, limit: 100, offset: 0);

            Assert.Equal(1, result.Total);
            Assert.Single(result.Items);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
            Assert.Equal("Override.esp", result.Items[0].Plugin);
            Assert.False(result.Items[0].IsWinner);
            Assert.Equal(1, result.Items[0].LoadOrderIndex); // Override.esp is second plugin (index 1)
        }
    }

    [Fact]
    public void GetRecords_ByPlugin_NonZeroOffset_DoesNotAppendStagedRecords()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-paging")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = new SchemaReflector();
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: "npc_", plugin: "Override.esp", search: null, limit: 100, offset: 1);

            Assert.Empty(result.Items);
        }
    }

    [Fact]
    public void GetRecords_ByPlugin_StagedOnlyRecords_UnknownPlugin_HasNegativeOneLoadOrderIndex()
    {
        // "Unknown.esp" is not in _manager's Plugins list → FirstOrDefault returns null → ?? -1 fires.
        var fk = FormKey.Factory("000001:Fallout4.esm");
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(fk.ToString(), "Unknown.esp", "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
            "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
        var svc = new RecordQueryService(_manager, changes, new SchemaReflector(), new ConflictClassifier());

        var result = svc.GetRecords(type: "npc_", plugin: "Unknown.esp", search: null, limit: 100, offset: 0);

        Assert.Single(result.Items);
        Assert.Equal(-1, result.Items[0].LoadOrderIndex);
    }

    [Fact]
    public void GetRecords_ByPlugin_StagedAlreadyCommittedRecordIsNotDuplicated()
    {
        // Pick an already-committed record from the loaded fixture, stage a pending change on it,
        // and verify it appears exactly once (no duplication between committed + staged sources).
        var committed = _svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: "TestNPC01", limit: 1, offset: 0);
        var fk = committed.Items[0].FormKey;

        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(fk, TestPluginFixture.PluginName, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
            "user", null, new Dictionary<string, System.Text.Json.JsonElement>());
        var svc = new RecordQueryService(_manager, changes, new SchemaReflector(), new ConflictClassifier());

        var result = svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    // --- GetPlugins: filter pruning (A4) ---

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        _manager.SetFilter($"SELECT form_key FROM \"NPC_\"");
        try
        {
            var plugins = _svc.GetPlugins();
            Assert.Contains(plugins, p => p.Name == TestPluginFixture.PluginName);
        }
        finally { _manager.ClearFilter(); }
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_HidesPlugin()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        try
        {
            var plugins = _svc.GetPlugins();
            Assert.Empty(plugins);
        }
        finally { _manager.ClearFilter(); }
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        _manager.ClearFilter();

        var plugins = _svc.GetPlugins();
        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
    }

    private sealed class SpyRecordReader(IRecordReader inner) : IRecordReader
    {
        public int FindRecordTypeCalls { get; private set; }
        public int GetRecordCalls { get; private set; }
        public bool? LastWinnerOnly { get; private set; }

        public void Reset() { FindRecordTypeCalls = 0; GetRecordCalls = 0; LastWinnerOnly = null; }

        public string? FindRecordType(string formKey)
        {
            FindRecordTypeCalls++;
            return inner.FindRecordType(formKey);
        }

        public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly)
        {
            GetRecordCalls++;
            LastWinnerOnly = winnerOnly;
            return inner.GetRecord(tableName, formKey, plugin, winnerOnly);
        }

        public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset) =>
            inner.GetRecords(tableName, plugin, search, limit, offset);

        public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) =>
            inner.GetAllOverrides(tableName, formKey);

        public VmadData? GetVmad(string formKey, string plugin) =>
            inner.GetVmad(formKey, plugin);

        public int CountRecordsForPlugin(string tableName, string plugin) =>
            inner.CountRecordsForPlugin(tableName, plugin);

        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset) =>
            inner.SearchRecords(tableNames, plugin, search, limit, offset);

        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
            inner.GetPluginsWithMatchingRecords(tableNames);

        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
            inner.GetReferences(targetFormKey);

        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey) =>
            inner.GetWorldspaceCells(plugin, worldspaceFormKey);
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset) =>
            inner.GetInteriorCells(plugin, limit, offset);
        public CellReferences GetCellReferences(string plugin, string cellFormKey) =>
            inner.GetCellReferences(plugin, cellFormKey);
        public PlacementRow? GetPlacement(string formKey, string plugin) =>
            inner.GetPlacement(formKey, plugin);
    }

    private sealed class StubSessionManager(IRecordReader repository, GameRelease release) : ISessionManager
    {
        public IGameSession? Session { get; } = new StubGameSession(release);
        public IRecordReader? Repository => repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    private sealed class StubGameSession(GameRelease release) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => release;
        public IReadOnlyList<PluginMetadata> Plugins => [];
        public Mutagen.Bethesda.Plugins.Cache.ILinkCache LinkCache => throw new NotSupportedException();
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
