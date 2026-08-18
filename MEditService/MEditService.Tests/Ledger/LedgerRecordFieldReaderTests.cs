using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #371 Q1: <see cref="LedgerRecordFieldReader"/> is the scratch-index round trip that stands in
/// for a hand-written native→JSON mapper (orchestrator-directed — see the class's own remarks for
/// why). This is the fidelity coverage that decision calls for: the three field shapes a
/// hand-written mapper would most plausibly get wrong — enum, FormKey, and an array carrying
/// FormKeys — proven to come back exactly as staged, not just "some value came back".
/// </summary>
public class LedgerRecordFieldReaderTests
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;

    [Fact]
    public void ReadFields_EnumFormKeyAndFormKeyArrayFields_RoundTripExactly()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var keyword1 = mod.Keywords.AddNew();
        var keyword2 = mod.Keywords.AddNew();
        var npc = mod.Npcs.AddNew("ScratchNpc");
        npc.Aggression = Npc.AggressionType.Aggressive; // enum
        npc.Keywords = [new FormLink<IKeywordGetter>(keyword1.FormKey), new FormLink<IKeywordGetter>(keyword2.FormKey)]; // array of FormKey

        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["npc_"];
        var repositoryFactory = new DuckDbRecordRepositoryFactory(Reflector, new TableDdlBuilder(Reflector));
        var reader = new LedgerRecordFieldReader(repositoryFactory);

        var fields = reader.ReadFields(npc, schema, "Scratch.esp", GameRelease.Fallout4);

        Assert.Equal("Aggressive", fields["aggression"].GetString());

        var keywordFormKeys = fields["keywords"].EnumerateArray().Select(e => e.GetString()).ToList();
        Assert.Equal([keyword1.FormKey.ToString(), keyword2.FormKey.ToString()], keywordFormKeys);
    }

    // The empty-array case is its own fidelity edge: a hand-written mapper distinguishing "empty
    // array" from "field absent"/"null" is exactly the kind of divergence Q1 worries about.
    [Fact]
    public void ReadFields_EmptyFormKeyArrayField_RoundTripsAsEmptyArray_NotNullOrMissing()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("ScratchNpc");
        npc.Keywords = []; // explicitly empty, not left unset (unset is null — a different, valid state)

        var schemas = Reflector.GetSchemas(GameRelease.Fallout4);
        var schema = schemas["npc_"];
        var repositoryFactory = new DuckDbRecordRepositoryFactory(Reflector, new TableDdlBuilder(Reflector));
        var reader = new LedgerRecordFieldReader(repositoryFactory);

        var fields = reader.ReadFields(npc, schema, "Scratch.esp", GameRelease.Fallout4);

        Assert.True(fields.TryGetValue("keywords", out var keywords));
        Assert.Equal(JsonValueKind.Array, keywords.ValueKind);
        Assert.Empty(keywords.EnumerateArray());
    }

    // Review finding (mutation axis): AddExisting == null is not hypothetical — probed directly
    // against the real FO4 schema set: 13 of 133 tables have no AddExisting delegate, including
    // common ones (cell, refr, achr, dial, info, gmst, glob, dmgt, dual, omod, header). A revert
    // targeting one of those record types must fail with this named exception, not a null-ref or a
    // silent no-op — "glob" (Global) is the cheapest to construct.
    [Fact]
    public void ReadFields_RecordTypeWithNoAddExistingDelegate_ThrowsNamedException()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var global = mod.Globals.AddNewFloat("ScratchGlobal");

        var schema = Reflector.GetSchemas(GameRelease.Fallout4)["glob"];
        Assert.Null(schema.AddExisting); // the precondition this test is about

        var repositoryFactory = new DuckDbRecordRepositoryFactory(Reflector, new TableDdlBuilder(Reflector));
        var reader = new LedgerRecordFieldReader(repositoryFactory);

        var ex = Assert.Throws<InvalidOperationException>(
            () => reader.ReadFields(global, schema, "Scratch.esp", GameRelease.Fallout4));
        Assert.Contains("glob", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    // Review finding (mutation axis): the scratch-index round trip's own "produced no row" guard —
    // reachable if the schema/record pair given don't actually agree (a caller error one level up
    // from this class, but this class's own job is to fail loud rather than return a wrong or empty
    // result). Faked at the repository boundary (never git) so this needs no contrived real-data
    // scenario: IRecordRepositoryFactory is already the seam this class depends on.
    [Fact]
    public void ReadFields_ScratchIndexProducesNoRow_ThrowsNamedException()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Scratch.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("ScratchNpc");
        var schema = Reflector.GetSchemas(GameRelease.Fallout4)["npc_"];

        var reader = new LedgerRecordFieldReader(new NullRowRecordRepositoryFactory());

        var ex = Assert.Throws<InvalidOperationException>(
            () => reader.ReadFields(npc, schema, "Scratch.esp", GameRelease.Fallout4));
        Assert.Contains(npc.FormKey.ToString(), ex.Message, StringComparison.Ordinal);
    }

    // Fakes only the repository boundary (never git — ADR-0040's own rule is about git specifically):
    // Index "succeeds" (a real indexer would too) but GetRecord always answers null, so the only
    // path under test is ReadFields' own post-index guard.
    private sealed class NullRowRecordRepositoryFactory : IRecordRepositoryFactory
    {
        public IRecordRepository Create(GameRelease gameRelease) => new NullRowRecordRepository();
    }

    private sealed class NullRowRecordRepository : IRecordRepository
    {
        public DuckDBConnection Connection => throw new NotSupportedException();
        public void Initialize(GameRelease release) { }
        public void Index(IModGetter pluginMod, int loadOrderIndex, bool participates, string origin) { }
        public void Unindex(string plugin, string origin) => throw new NotSupportedException();
        public void UpdateWinners() => throw new NotSupportedException();
        public void SetPluginParticipation(string plugin, bool participates, string origin) => throw new NotSupportedException();
        public void SetFilter(string? sql) => throw new NotSupportedException();
        public void Dispose() { }

        public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            throw new NotSupportedException();
        public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, string? origin, bool winnerOnly) => null;
        public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) => throw new NotSupportedException();
        public VmadData? GetVmad(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin) => throw new NotSupportedException();
        public int CountRecordsForPlugin(string tableName, string plugin, string origin) => throw new NotSupportedException();
        public string? FindRecordType(string formKey) => throw new NotSupportedException();
        public RecordLookupEntry? ResolveFormKey(string formKey) => throw new NotSupportedException();
        public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) => throw new NotSupportedException();
        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            throw new NotSupportedException();
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) => throw new NotSupportedException();
        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) => throw new NotSupportedException();
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey, string origin) => throw new NotSupportedException();
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string origin) => throw new NotSupportedException();
        public CellReferences GetCellReferences(string plugin, string cellFormKey, string origin) => throw new NotSupportedException();
        public PlacementRow? GetPlacement(string formKey, string plugin, string origin) => throw new NotSupportedException();
    }
}
