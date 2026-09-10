using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>Field values only, not <c>FieldMetadata</c>: metadata is schema-derived, identical by
/// construction, and would bury the values under thousands of lines of enum domains.</summary>
public sealed class RealDataReadGoldenTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly DuckDbRecordIndex _repo = fixture.Repo;
    private const string Origin = "Data";
    private const int PerType = 3;
    // Larger than the record count of any type in the cut-down plugin (info, the largest, has 2,873).
    private const int WholeType = 5000;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

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

    // Listing order is ORDER BY editor_id and real placed refs and cells have none, so which rows a
    // small page returns is up to the engine's tie-breaking: sampling would make this golden's own
    // subject non-deterministic.
    private IReadOnlyList<string> FormKeysOf(string type) =>
        [.. _repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: [type], Limit: WholeType, Offset: 0)).Items
            .Select(r => r.FormKey).Order(StringComparer.Ordinal).Take(PerType)];

    // Total plus the first rows of the sorted listing: `info` alone has 2,873 rows, and a golden that
    // is 90% repetition is one nobody re-reads when it fails.
    private object WholeListing(string type)
    {
        var page = _repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: [type], Plugin: new PluginKey(TestPluginName, Origin), Limit: WholeType, Offset: 0));
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
                .Select(fk => _repo.At(RecordRef.Effective).GetDocument(fk, new PluginKey(TestPluginName, Origin)))
                .Where(d => d != null)
                .Select(d => Project(d!))
                .ToList());

        Golden.Verify("realdata-record-detail", captured);
    }

    [Fact]
    public void Listings_AndCounts_MatchGolden()
    {
        var captured = new
        {
            Counts = Types.ToDictionary(t => t, t => _repo.At(RecordRef.Effective).GetRecordTypeCounts(new PluginKey(TestPluginName, Origin))
                .FirstOrDefault(c => string.Equals(c.Type, t, StringComparison.OrdinalIgnoreCase))?.Count ?? 0),
            Listings = Types.ToDictionary(t => t, WholeListing),
            SearchAllTypesTotal = _repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: [.. Types], Plugin: new PluginKey(TestPluginName, Origin), Limit: WholeType, Offset: 0)).Total,
            SearchByEditorId = _repo.At(RecordRef.Effective).Search(new RecordQuery(RecordTypes: [.. Types], Plugin: new PluginKey(TestPluginName, Origin), Search: "Workshop", Limit: WholeType, Offset: 0))
                .Items.OrderBy(r => r.FormKey, StringComparer.Ordinal).Take(20).ToList(),
            NativeFormKeyCount = _repo.At(RecordRef.Effective).GetNativeFormKeys(new PluginKey(TestPluginName, Origin)).Count,
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
                fk => fk, fk => _repo.At(RecordRef.Effective).GetWorldspaceCells(new PluginKey(TestPluginName, Origin), fk)
                    .OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList()),
            InteriorCells = _repo.At(RecordRef.Effective).GetInteriorCells(new PluginKey(TestPluginName, Origin), WholeType, 0)
                .Items.OrderBy(c => c.FormKey, StringComparer.Ordinal).ToList(),
            CellReferences = cells.ToDictionary(
                fk => fk, fk =>
                {
                    var refs = _repo.At(RecordRef.Effective).GetCellReferences(new PluginKey(TestPluginName, Origin), fk);
                    return new
                    {
                        Persistent = refs.Persistent.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                        Temporary = refs.Temporary.OrderBy(r => r.FormKey, StringComparer.Ordinal).ToList(),
                    };
                }),
            Placements = FormKeysOf("refr").ToDictionary(
                fk => fk, fk => _repo.At(RecordRef.Effective).GetPlacement(fk, new PluginKey(TestPluginName, Origin))),
        };

        Golden.Verify("realdata-spatial", captured);
    }

    [Fact]
    public void ReferencesAndResolution_MatchGolden()
    {
        // Targets are drawn from every captured record and then narrowed to what something points at: a
        // curated slice can contain keywords nothing references, pinning an all-empty golden that passes
        // after the reference index stops being populated.
        var allFormKeys = Types.SelectMany(FormKeysOf).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
        var captured = new
        {
            // One keyword here is referenced 1,248 times, which would bury the golden. The count
            // catches a reference index that stopped being populated; the sample catches a changed
            // row.
            ReferencedBy = allFormKeys
                .Select(fk => (FormKey: fk, Refs: _repo.At(RecordRef.Effective).GetReferencedBy(fk)))
                .Where(r => r.Refs.Count > 0)
                .ToDictionary(r => r.FormKey, r => new
                {
                    Count = r.Refs.Count,
                    Sample = r.Refs
                        .OrderBy(x => x.FormKey, StringComparer.Ordinal)
                        .ThenBy(x => x.FieldPath, StringComparer.Ordinal)
                        .Take(5).ToList(),
                }),
            Resolved = allFormKeys.ToDictionary(fk => fk, _repo.At(RecordRef.Effective).Resolve),
        };

        Assert.NotEmpty(captured.ReferencedBy);
        Golden.Verify("realdata-references", captured);
    }

    private const string TestPluginName = CutDownPluginFixture.PluginFileName;
}
