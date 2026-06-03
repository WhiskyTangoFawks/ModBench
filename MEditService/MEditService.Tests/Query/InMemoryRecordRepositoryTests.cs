using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

public class InMemoryRecordRepositoryTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private static readonly ISchemaReflector _reflector = new SchemaReflector();

    public InMemoryRecordRepositoryTests(TestPluginFixture fixture) => _fixture = fixture;

    private InMemoryRecordRepository LoadedRepository()
    {
        var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.UpdateWinners();
        return repo;
    }

    // --- GetRecords ---

    [Fact]
    public void GetRecords_ByTable_ReturnsAllRecords()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_WithPluginFilter_ReturnsMatchingOnly()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", TestPluginFixture.PluginName, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_WithPluginFilter_WrongPlugin_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", "NonExistent.esp", null, 100, 0);
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void GetRecords_WithSearch_FiltersOnEditorId()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, "TestNPC01", 100, 0);
        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        using var repo = LoadedRepository();
        var page1 = repo.GetRecords("npc_", null, null, 1, 0);
        var page2 = repo.GetRecords("npc_", null, null, 1, 1);
        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // --- GetRecord ---

    [Fact]
    public void GetRecord_WinnerOnly_ReturnsWinner()
    {
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = repo.GetRecord("npc_", formKey, null, winnerOnly: true);

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal(formKey, record.FormKey);
    }

    [Fact]
    public void GetRecord_WithPlugin_ReturnsMatchingPlugin()
    {
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();

        var record = repo.GetRecord("npc_", formKey, TestPluginFixture.PluginName, winnerOnly: false);

        Assert.NotNull(record);
        Assert.Equal(TestPluginFixture.PluginName, record.Plugin);
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        using var repo = LoadedRepository();

        var record = repo.GetRecord("npc_", "FFFFFF:Unknown.esp", null, winnerOnly: false);

        Assert.Null(record);
    }

    // --- GetAllOverrides ---

    [Fact]
    public void GetAllOverrides_SinglePlugin_ReturnsSingleEntry()
    {
        using var repo = LoadedRepository();
        var formKey = _fixture.Npc1FormKey.ToString();

        var overrides = repo.GetAllOverrides("npc_", formKey);

        Assert.Single(overrides);
        Assert.Equal(formKey, overrides[0].FormKey);
    }

    [Fact]
    public void GetAllOverrides_TwoPlugins_OrderedByLoadOrderIndex_WinnerIsHigher()
    {
        // Build two-plugin fixture: PluginA defines an NPC, PluginB overrides it
        var data = new PluginFixtureBuilder("inmem-overrides").Build();
        var modAPath = Path.Combine(data.DataFolder, "PluginA.esm");

        FormKey npcKey;
        var modA = new Fallout4Mod(ModKey.FromFileName("PluginA.esm"), Fallout4Release.Fallout4);
        var npc = modA.Npcs.AddNew("SharedNPC");
        npcKey = npc.FormKey;
        modA.WriteToBinary(modAPath);

        var modALoaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("PluginA.esm"), modAPath),
            Fallout4Release.Fallout4);

        var modB = new Fallout4Mod(ModKey.FromFileName("PluginB.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.MasterReferences.Add(new MasterReference
        { Master = ModKey.FromFileName("PluginA.esm") });
        var overrideNpc = modALoaded.Npcs.First().DeepCopy();
        modB.Npcs.Set(overrideNpc);

        using var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(modALoaded, 0);
        repo.Index(modB, 1);
        repo.UpdateWinners();

        var overrides = repo.GetAllOverrides("npc_", npcKey.ToString());

        Assert.Equal(2, overrides.Count);
        Assert.Equal(0, overrides[0].LoadOrderIndex);
        Assert.Equal(1, overrides[1].LoadOrderIndex);
        Assert.False(overrides[0].IsWinner);
        Assert.True(overrides[1].IsWinner);

        data.Dispose();
    }

    // --- CountRecordsForPlugin ---

    [Fact]
    public void CountRecordsForPlugin_ReturnsCorrectCount()
    {
        using var repo = LoadedRepository();
        var count = repo.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName);
        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void CountRecordsForPlugin_UnknownPlugin_ReturnsZero()
    {
        using var repo = LoadedRepository();
        var count = repo.CountRecordsForPlugin("npc_", "NonExistent.esp");
        Assert.Equal(0, count);
    }

    // --- FindRecordType ---

    [Fact]
    public void FindRecordType_KnownFormKey_ReturnsTableName()
    {
        using var repo = LoadedRepository();
        var tableName = repo.FindRecordType(_fixture.Npc1FormKey.ToString());
        Assert.Equal("npc_", tableName);
    }

    [Fact]
    public void FindRecordType_UnknownFormKey_ReturnsNull()
    {
        using var repo = LoadedRepository();
        var tableName = repo.FindRecordType("FFFFFF:Unknown.esp");
        Assert.Null(tableName);
    }

    // --- UpdateWinners ---

    [Fact]
    public void UpdateWinners_SinglePlugin_AllRecordsAreWinners()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Index_BeforeUpdateWinners_NoRecordsAreWinners()
    {
        // Verifies that isWinner starts false and only becomes true after UpdateWinners
        using var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        // UpdateWinners not called — records must still be non-winners
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        Assert.All(result.Items, r => Assert.False(r.IsWinner));
    }

    // --- Index guard + idempotency ---

    [Fact]
    public void Index_BeforeInitialize_Throws()
    {
        using var repo = new InMemoryRecordRepository(_reflector);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        Assert.Throws<InvalidOperationException>(() => repo.Index(mod, 0));
    }

    [Fact]
    public void Index_SamePluginTwice_DoesNotDuplicateRecords()
    {
        using var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName(TestPluginFixture.PluginName),
            Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName));
        using var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0);
        repo.Index(mod, 0); // re-index same plugin
        repo.UpdateWinners();
        var count = repo.CountRecordsForPlugin("npc_", TestPluginFixture.PluginName);
        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    // --- Connection ---

    [Fact]
    public void Connection_ThrowsNotSupportedException()
    {
        using var repo = new InMemoryRecordRepository(_reflector);
        Assert.Throws<NotSupportedException>(() => _ = repo.Connection);
    }

    // --- GetRecords sort order ---

    [Fact]
    public void GetRecords_ResultsAreSortedAscendingByEditorId()
    {
        using var repo = LoadedRepository();
        var result = repo.GetRecords("npc_", null, null, 100, 0);
        var editorIds = result.Items.Select(r => r.EditorId).ToList();
        var sorted = editorIds.OrderBy(e => e, StringComparer.OrdinalIgnoreCase).ToList();
        Assert.Equal(sorted, editorIds);
    }

    // --- GetRecord winnerOnly with multiple overrides ---

    [Fact]
    public void GetRecord_WinnerOnly_ExcludesNonWinners()
    {
        var data = new PluginFixtureBuilder("inmem-winneronly").Build();
        var modAPath = Path.Combine(data.DataFolder, "WinnerA.esm");

        FormKey npcKey;
        var modA = new Fallout4Mod(ModKey.FromFileName("WinnerA.esm"), Fallout4Release.Fallout4);
        var npc = modA.Npcs.AddNew("WinnerTestNPC");
        npcKey = npc.FormKey;
        modA.WriteToBinary(modAPath);

        using var modALoaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("WinnerA.esm"), modAPath),
            Fallout4Release.Fallout4);

        var modB = new Fallout4Mod(ModKey.FromFileName("WinnerB.esp"), Fallout4Release.Fallout4);
        modB.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("WinnerA.esm") });
        modB.Npcs.Set(modALoaded.Npcs.First().DeepCopy());

        using var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(modALoaded, 0);
        repo.Index(modB, 1);
        repo.UpdateWinners();

        var record = repo.GetRecord("npc_", npcKey.ToString(), null, winnerOnly: true);

        Assert.NotNull(record);
        Assert.True(record.IsWinner);
        Assert.Equal("WinnerB.esp", record.Plugin);
        data.Dispose();
    }

    // --- SearchRecords ---

    [Fact]
    public void SearchRecords_SingleTable_ReturnsAllRecords()
    {
        using var repo = LoadedRepository();
        var result = repo.SearchRecords(["npc_"], null, null, 100, 0);
        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void SearchRecords_WithSearch_FiltersResults()
    {
        using var repo = LoadedRepository();
        var result = repo.SearchRecords(["npc_"], null, "TestNPC01", 100, 0);
        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    [Fact]
    public void SearchRecords_EmptyTableList_ReturnsEmpty()
    {
        using var repo = LoadedRepository();
        var result = repo.SearchRecords([], null, null, 100, 0);
        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void SearchRecords_MultiplePlugins_ResultsSortedByEditorIdAscending()
    {
        // Index records from two independent plugins so they interleave alphabetically.
        // Without the Sort() in SearchRecords, results arrive in insertion order (Bravo before Alpha).
        var data = new PluginFixtureBuilder("inmem-search-sort").Build();
        var modAPath = Path.Combine(data.DataFolder, "SortA.esm");
        var modBPath = Path.Combine(data.DataFolder, "SortB.esm");

        var modA = new Fallout4Mod(ModKey.FromFileName("SortA.esm"), Fallout4Release.Fallout4);
        modA.Npcs.AddNew("Bravo");
        modA.WriteToBinary(modAPath);

        var modB = new Fallout4Mod(ModKey.FromFileName("SortB.esm"), Fallout4Release.Fallout4);
        modB.Npcs.AddNew("Alpha");
        modB.WriteToBinary(modBPath);

        var modALoaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("SortA.esm"), modAPath), Fallout4Release.Fallout4);
        var modBLoaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("SortB.esm"), modBPath), Fallout4Release.Fallout4);

        using var repo = new InMemoryRecordRepository(_reflector);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index(modALoaded, 0);  // Bravo indexed first
        repo.Index(modBLoaded, 1);  // Alpha indexed second
        repo.UpdateWinners();

        var result = repo.SearchRecords(["npc_"], null, null, 100, 0);

        Assert.Equal(2, result.Total);
        Assert.Equal("Alpha", result.Items[0].EditorId);
        Assert.Equal("Bravo", result.Items[1].EditorId);

        data.Dispose();
    }
}
