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
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Session;

public sealed class SessionManagerLoadExplicitTests
{
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
    }

    [Fact]
    public void LoadExplicit_PopulatesSessionAndIndexesScatteredPlugins()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.NotNull(manager.Repository);
        Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "A.esp"));
        Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "B.esp"));
    }

    [Fact]
    public void LoadExplicit_CrossPluginOverride_WinnerIsHighestOrderPlugin()
    {
        FormKey shared = default;
        using var fx = new PluginFixtureBuilder("sm-explicit-winner")
            .WithPlugin("Base.esm", mod => shared = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Override.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First().DeepCopy());
            })
            .BuildScattered();

        using var manager = MakeManager();
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var winner = manager.Repository!.GetRecord("npc_", shared.ToString(), null, winnerOnly: true);
        Assert.NotNull(winner);
        Assert.True(winner.IsWinner);
        Assert.Equal("Override.esp", winner.Plugin);
    }

    [Fact]
    public void LoadExplicit_ReplacesPriorSession()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-replace")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        using var manager = MakeManager();
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Repository;

        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotSame(firstRepo, manager.Repository);
        Assert.ThrowsAny<Exception>(() => firstRepo!.CountRecordsForPlugin("npc_", "A.esp"));
    }

    // A single plugin whose binary data Mutagen can't parse (e.g. #<issue>: a malformed
    // PerkEntryPointAddActivateChoice missing its EPF3 record) must not abort the whole load
    // order — mirrors the existing per-plugin isolation around ModFactory.ImportGetter in
    // GameSession, extended to the indexing stage.
    [Fact]
    public void LoadExplicit_OnePluginFailsToIndex_OthersStillLoadAndFailureIsReported()
    {
        using var fx = new PluginFixtureBuilder("sm-explicit-index-failure")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("FromGood"))
            .WithPlugin("Bad.esp", mod => mod.Npcs.AddNew("FromBad"))
            .BuildScattered();

        var reflector = SharedSchemaReflector.Instance;
        var innerFactory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var factory = new ThrowingOnIndexRepositoryFactory(innerFactory, "Bad.esp");
        using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));

        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Session);
        Assert.Contains(manager.Session!.LoadFailures, f => f.Name == "Bad.esp");
        Assert.Equal(1, manager.Repository!.CountRecordsForPlugin("npc_", "Good.esp"));
        Assert.Equal(0, manager.Repository!.CountRecordsForPlugin("npc_", "Bad.esp"));
    }

    private sealed class ThrowingOnIndexRepositoryFactory(IRecordRepositoryFactory inner, string poisonPlugin)
        : IRecordRepositoryFactory
    {
        public IRecordRepository Create(GameRelease gameRelease) =>
            new ThrowingOnIndexRepository(inner.Create(gameRelease), poisonPlugin);
    }

    private sealed class ThrowingOnIndexRepository(IRecordRepository inner, string poisonPlugin) : IRecordRepository
    {
        public DuckDBConnection Connection => inner.Connection;
        public void SetFilter(string? sql) => inner.SetFilter(sql);
        public void Initialize(GameRelease release) => inner.Initialize(release);

        public void Index(IModGetter pluginMod, int loadOrderIndex)
        {
            if (pluginMod.ModKey.FileName.ToString().Equals(poisonPlugin, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"injected index failure for {poisonPlugin}");
            inner.Index(pluginMod, loadOrderIndex);
        }

        public void UpdateWinners() => inner.UpdateWinners();
        public void Dispose() => inner.Dispose();

        public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset) =>
            inner.GetRecords(tableName, plugin, search, limit, offset);
        public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, bool winnerOnly) =>
            inner.GetRecord(tableName, formKey, plugin, winnerOnly);
        public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) =>
            inner.GetAllOverrides(tableName, formKey);
        public VmadData? GetVmad(string formKey, string plugin) => inner.GetVmad(formKey, plugin);
        public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin) =>
            inner.GetConditions(formKey, plugin);
        public int CountRecordsForPlugin(string tableName, string plugin) =>
            inner.CountRecordsForPlugin(tableName, plugin);
        public string? FindRecordType(string formKey) => inner.FindRecordType(formKey);
        public RecordLookupEntry? ResolveFormKey(string formKey) => inner.ResolveFormKey(formKey);
        public IReadOnlyList<string> GetNativeFormKeys(string plugin) => inner.GetNativeFormKeys(plugin);
        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset) =>
            inner.SearchRecords(tableNames, plugin, search, limit, offset);
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
            inner.GetPluginsWithMatchingRecords(tableNames);
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => inner.GetReferences(targetFormKey);
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey) =>
            inner.GetWorldspaceCells(plugin, worldspaceFormKey);
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset) =>
            inner.GetInteriorCells(plugin, limit, offset);
        public CellReferences GetCellReferences(string plugin, string cellFormKey) =>
            inner.GetCellReferences(plugin, cellFormKey);
        public PlacementRow? GetPlacement(string formKey, string plugin) => inner.GetPlacement(formKey, plugin);
    }
}
