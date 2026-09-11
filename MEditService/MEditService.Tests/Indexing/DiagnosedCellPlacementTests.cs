using System.Globalization;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>The placement side tables come from the GRUP hierarchy (ADR-0005), read without the
/// codec, so a cell whose document the codec refuses still lists and still holds its contents.</summary>
public sealed class DiagnosedCellPlacementTests
{
    private const string Plugin = "Diagnosed.esp";

    private const string CellFormKey = "000800:Diagnosed.esp";

    private const string PersistentRef = "000801:Diagnosed.esp";

    private const string TemporaryRef = "000802:Diagnosed.esp";

    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;

    private static DuckDbRecordIndex Indexed(string? cellDiagnosis)
    {
        var repo = new DuckDbRecordIndex(Reflector, new TableDdlBuilder(Reflector), NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        using var documents = new StubDocuments(cellDiagnosis);
        repo.Index(documents, Registration.Participating(0), new PluginKey(Plugin, "Data"));
        repo.UpdateWinners();
        return repo;
    }

    [Fact]
    public void ACellTheCodecRefuses_StillLandsItsLocation_WithItsGridUnknown()
    {
        using var repo = Indexed(cellDiagnosis: "the codec refused this cell");

        var row = Assert.Single(Query(
            repo, "SELECT parent_worldspace, block_x, sub_y, grid_x, is_interior FROM cell_location WHERE cell_form_key = $1",
            CellFormKey));

        Assert.Equal("000900:Diagnosed.esp", row["parent_worldspace"]);
        Assert.Equal(3, Convert.ToInt32(row["block_x"], CultureInfo.InvariantCulture));
        Assert.Equal(2, Convert.ToInt32(row["sub_y"], CultureInfo.InvariantCulture));
        Assert.Null(row["grid_x"]);
        Assert.False(Convert.ToBoolean(row["is_interior"], CultureInfo.InvariantCulture));
    }

    [Fact]
    public void ACellTheCodecRefuses_StillLandsAPlacementRowPerRefItHolds_WithPositionsUnknown()
    {
        using var repo = Indexed(cellDiagnosis: "the codec refused this cell");

        var persistent = Assert.Single(Query(
            repo, "SELECT parent_cell, placement_group, pos_x FROM placement WHERE form_key = $1", PersistentRef));
        Assert.Equal(CellFormKey, persistent["parent_cell"]);
        Assert.Equal("persistent", persistent["placement_group"]);
        Assert.Null(persistent["pos_x"]);

        var temporary = Assert.Single(Query(
            repo, "SELECT parent_cell, placement_group FROM placement WHERE form_key = $1", TemporaryRef));
        Assert.Equal(CellFormKey, temporary["parent_cell"]);
        Assert.Equal("temporary", temporary["placement_group"]);
    }

    // The same fixture with the cell readable, so what the diagnosis costs is legible: the grid and
    // the positions, and nothing else.
    [Fact]
    public void TheSameCellReadable_LandsTheSameRows_WithItsGridAndPositions()
    {
        using var repo = Indexed(cellDiagnosis: null);

        var location = Assert.Single(Query(
            repo, "SELECT grid_x, grid_y FROM cell_location WHERE cell_form_key = $1", CellFormKey));
        Assert.Equal(12, Convert.ToInt32(location["grid_x"], CultureInfo.InvariantCulture));
        Assert.Equal(-5, Convert.ToInt32(location["grid_y"], CultureInfo.InvariantCulture));

        var persistent = Assert.Single(Query(
            repo, "SELECT pos_x, pos_z FROM placement WHERE form_key = $1", PersistentRef));
        Assert.Equal(10f, Convert.ToSingle(persistent["pos_x"], CultureInfo.InvariantCulture));
        Assert.Equal(30f, Convert.ToSingle(persistent["pos_z"], CultureInfo.InvariantCulture));
    }

    // A temporary ref whose document spells no position: the row carries none rather than the origin.
    [Fact]
    public void ARefWhoseDocumentSpellsNoPosition_LandsWithNullCoordinates()
    {
        using var repo = Indexed(cellDiagnosis: null);

        var row = Assert.Single(Query(
            repo, "SELECT pos_x, pos_y, pos_z FROM placement WHERE form_key = $1", TemporaryRef));

        Assert.Null(row["pos_x"]);
        Assert.Null(row["pos_y"]);
        Assert.Null(row["pos_z"]);
    }

    private static List<Dictionary<string, object?>> Query(DuckDbRecordIndex repo, string sql, string param)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.Add(new DuckDBParameter { Value = param });
        using var reader = cmd.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>(StringComparer.Ordinal);
            for (var i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    // Hand-built rather than serialized from a mod: no fixture plugin holds a cell the codec refuses,
    // and what is under test is what the ingest does with a diagnosis, not how one arises.
    private sealed class StubDocuments(string? cellDiagnosis) : IPluginDocuments
    {
        private const string ReadableCell = """
            {
              "FormKey": "000800:Diagnosed.esp",
              "EditorID": "DiagnosedCell",
              "Grid": {
                "Point": "12, -5"
              },
              "Persistent": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000801:Diagnosed.esp",
                  "Position": "10, 20, 30"
                }
              ],
              "Temporary": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "000802:Diagnosed.esp"
                }
              ]
            }
            """;

        private const string RefusedCell = """{"FormKey": "000800:Diagnosed.esp"}""";

        public PluginDocument Header => new("header", $"000000:{Plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records =>
        [
            new PluginDocument(
                "cell", CellFormKey,
                cellDiagnosis is null ? ReadableCell : RefusedCell,
                cellDiagnosis,
                new CellStructure("000900:Diagnosed.esp", 3, 4, 1, 2, IsInterior: false),
                [new PlacedInCell(PersistentRef, "persistent"), new PlacedInCell(TemporaryRef, "temporary")]),
        ];

        public void Dispose()
        {
        }
    }
}
