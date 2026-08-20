using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// #413 slice S0 — the AC3 safety net, captured from the pre-swap implementation over authentic
/// Bethesda records (the committed cut-down plugin: real translated strings, real flags bitmasks,
/// real struct/array columns, real GLOB multi-subclass columns, real VMAD, real conditions, a real
/// worldspace/cell/placement tree).
///
/// This is the fixture that makes "identical results to before the swap" a testable claim. The
/// documents read model reconstitutes each record from its own ledger JSON and runs the <i>same</i>
/// <c>ColumnSpec.Extract</c> delegates the wide tables were filled from, so every value below must
/// survive the swap unchanged — and where one does not, this test names the field rather than
/// leaving it to be discovered in the compare grid.
///
/// Field <i>values</i> only, deliberately, not <c>FieldMetadata</c>: metadata is schema-derived
/// (identical by construction on both sides of the swap, since both read the same reflected
/// ColumnSpecs) and would bury the values under thousands of lines of enum domains.
/// </summary>
public sealed class RealDataReadGoldenTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly DuckDbRecordIndex _repo = fixture.Repo;
    private const string Origin = "Data";
    private const int PerType = 3;
    // Larger than the record count of any type in the cut-down plugin (info, the largest, has 2,873).
    private const int WholeType = 5000;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    // #421: GetVmad/GetConditions are rejected from IRecordReads/IRecordIndex — reconstitution
    // moved to Queries/RecordDocumentCodecs, operating on RecordDocument.Body.
    private VmadData? GetVmad(string formKey)
    {
        var document = _repo.GetDocument(formKey, new PluginKey(TestPluginName, Origin));
        return document == null ? null : RecordDocumentCodecs.GetVmad(document, GameRelease.Fallout4, NullLogger.Instance);
    }

    private IReadOnlyList<ConditionOwner> GetConditions(string formKey)
    {
        var document = _repo.GetDocument(formKey, new PluginKey(TestPluginName, Origin));
        return document == null ? [] : RecordDocumentCodecs.GetConditions(document, GameRelease.Fallout4, ConditionCodecRegistry.For(GameRelease.Fallout4.ToCategory()));
    }

    /// <summary>Record types the cut-down plugin actually carries, in a fixed order.</summary>
    private static readonly string[] Types =
        ["achr", "acti", "armo", "cell", "dial", "dlbr", "fact", "glob", "info", "kywd", "misc", "npc_", "qust", "race", "refr", "scen", "weap", "wrld"];

    private static object Project(RecordDocument d) => new
    {
        d.FormKey,
        Plugin = d.Plugin.Name,
        Origin = d.Plugin.Origin ?? "",
        d.LoadOrderIndex,
        d.IsWinner,
        d.EditorId,
        d.RecordType,
        Fields = d.Fields.ToDictionary(f => f.Metadata.Name, f => f.Value),
        CheckErrors = d.Fields.Where(f => f.CheckError != null).ToDictionary(f => f.Metadata.Name, f => f.CheckError),
    };

    // Whole-type listing, then sort, then take — never a small LIMIT and take. Listing order is
    // ORDER BY editor_id, and real placed refs and cells have no EditorID at all, so which rows a
    // 12-row page returns is up to the engine's tie-breaking: sampling from it would make this
    // golden's very *subject* non-deterministic, and the resulting flake would read as a swap
    // regression.
    private IReadOnlyList<string> FormKeysOf(string type) =>
        [.. _repo.Search(new RecordQuery(RecordTypes: [type], Limit: WholeType, Offset: 0)).Items
            .Select(r => r.FormKey).Order(StringComparer.Ordinal).Take(PerType)];

    // Total (exact) plus the first rows of the sorted whole listing — the same count-plus-sample
    // shape the reference golden uses, and for the same reason: `info` alone has 2,873 rows, and a
    // golden that is 90% repetition is a golden nobody re-reads when it fails.
    private object WholeListing(string type)
    {
        var page = _repo.Search(new RecordQuery(RecordTypes: [type], Plugin: new PluginKey(TestPluginName, Origin), Limit: WholeType, Offset: 0));
        return new
        {
            page.Total,
            Sample = page.Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(10).ToList(),
        };
    }

    [Fact]
    public void RecordDetail_ForEveryRecordType_MatchesGolden()
    {
        var captured = Types.ToDictionary(
            type => type,
            type => FormKeysOf(type)
                .Select(fk => _repo.GetDocument(fk, new PluginKey(TestPluginName, Origin)))
                .Where(d => d != null)
                .Select(d => Project(d!))
                .ToList());

        Golden.Verify("realdata-record-detail", captured);
    }

    [Fact]
    public void Vmad_ForEveryRecordType_MatchesGolden()
    {
        var captured = Types
            .SelectMany(type => FormKeysOf(type).Select(fk => (Type: type, FormKey: fk)))
            .Select(r => (r.Type, r.FormKey, Vmad: GetVmad(r.FormKey)))
            .Where(r => r.Vmad != null)
            .ToDictionary(r => $"{r.Type}/{r.FormKey}", r => r.Vmad);

        Assert.NotEmpty(captured); // the fixture must actually exercise VMAD, or this golden is vacuous
        Golden.Verify("realdata-vmad", captured);
    }

    [Fact]
    public void Conditions_ForEveryRecordType_MatchesGolden()
    {
        var captured = Types
            .SelectMany(type => FormKeysOf(type).Select(fk => (Type: type, FormKey: fk)))
            .Select(r => (r.Type, r.FormKey, Owners: GetConditions(r.FormKey)))
            .Where(r => r.Owners.Count > 0)
            .ToDictionary(r => $"{r.Type}/{r.FormKey}", r => r.Owners);

        Assert.NotEmpty(captured); // ditto: a fixture with no conditions would pin nothing
        Golden.Verify("realdata-conditions", captured);
    }

    [Fact]
    public void Listings_AndCounts_MatchGolden()
    {
        var captured = new
        {
            Counts = Types.ToDictionary(t => t, t => _repo.GetRecordTypeCounts(new PluginKey(TestPluginName, Origin))
                .FirstOrDefault(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase))?.Count ?? 0),
            Listings = Types.ToDictionary(t => t, WholeListing),
            SearchAllTypesTotal = _repo.Search(new RecordQuery(RecordTypes: [.. Types], Plugin: new PluginKey(TestPluginName, Origin), Limit: WholeType, Offset: 0)).Total,
            SearchByEditorId = _repo.Search(new RecordQuery(RecordTypes: [.. Types], Plugin: new PluginKey(TestPluginName, Origin), Search: "Workshop", Limit: WholeType, Offset: 0))
                .Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(20).ToList(),
            NativeFormKeyCount = _repo.GetNativeFormKeys(new PluginKey(TestPluginName, Origin)).Count,
        };

        Golden.Verify("realdata-listings", captured);
    }

    [Fact]
    public void SpatialReads_MatchGolden()
    {
        var worldspaces = FormKeysOf("wrld");
        var cells = FormKeysOf("cell");
        var captured = new
        {
            WorldspaceCells = worldspaces.ToDictionary(
                fk => fk, fk => _repo.GetWorldspaceCells(new PluginKey(TestPluginName, Origin), fk)
                    .OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList()),
            InteriorCells = _repo.GetInteriorCells(new PluginKey(TestPluginName, Origin), WholeType, 0)
                .Items.OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList(),
            CellReferences = cells.ToDictionary(
                fk => fk, fk =>
                {
                    var refs = _repo.GetCellReferences(new PluginKey(TestPluginName, Origin), fk);
                    return new
                    {
                        Persistent = refs.Persistent.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                        Temporary = refs.Temporary.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                    };
                }),
            Placements = FormKeysOf("refr").ToDictionary(
                fk => fk, fk => _repo.GetPlacement(fk, new PluginKey(TestPluginName, Origin))),
        };

        Golden.Verify("realdata-spatial", captured);
    }

    [Fact]
    public void ReferencesAndResolution_MatchGolden()
    {
        // Targets are drawn from every captured record and then narrowed to the ones something
        // actually points at, rather than from a guessed record type — a curated slice can easily
        // contain keywords nothing in it references, which would pin an all-empty golden that
        // passes just as well after the reference index stops being populated at all.
        var allFormKeys = Types.SelectMany(FormKeysOf).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var captured = new
        {
            // Count plus a deterministic sample, not the whole list: one keyword in this slice is
            // referenced 1,248 times by dialogue, which would bury the golden in near-identical
            // rows. The count catches a reference index that stopped being populated or changed
            // fan-out; the sample catches a row whose shape or values changed. GetReferences has
            // no ORDER BY of its own, so the sort here is what makes the sample stable at all.
            ReferencedBy = allFormKeys
                .Select(fk => (FormKey: fk, Refs: _repo.GetReferencedBy(fk)))
                .Where(r => r.Refs.Count > 0)
                .ToDictionary(r => r.FormKey, r => new
                {
                    Count = r.Refs.Count,
                    Sample = r.Refs
                        .OrderBy(x => x.FormKey, StringComparer.Ordinal)
                        .ThenBy(x => x.FieldPath, StringComparer.Ordinal)
                        .Take(5).ToList(),
                }),
            Resolved = allFormKeys.ToDictionary(fk => fk, _repo.Resolve),
        };

        Assert.NotEmpty(captured.ReferencedBy);
        Golden.Verify("realdata-references", captured);
    }

    private const string TestPluginName = CutDownPluginFixture.PluginFileName;
}
