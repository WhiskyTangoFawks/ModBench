using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

/// <summary>The placement reads come from the GRUP hierarchy (ADR-0005), read without the codec,
/// so a cell whose document the codec refuses still lists and still holds its contents.</summary>
public sealed class DiagnosedCellPlacementTests : IDisposable
{
    private const string Plugin = "Diagnosed.esp";
    private const string CellFormKey = "000800:Diagnosed.esp";
    private const string PersistentRef = "000801:Diagnosed.esp";
    private const string TemporaryRef = "000802:Diagnosed.esp";
    private static readonly PluginAddress Key = new(Plugin, PluginOrigin.DataDirectory);

    // Any real binary: the adapter double below answers the documents, the binary only the open.
    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("diagnosed-cell").WithPlugin(Plugin).Build();

    public void Dispose() => _fixture.Dispose();

    private Indexer Indexed(string? cellDiagnosis) =>
        Indexes.Reconciled(_fixture, adapter: new StubbedDocumentsAdapter(cellDiagnosis));

    [Fact]
    public void ACellTheCodecRefuses_StillLandsItsLocation_WithItsGridUnknown()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");

        var location = index.RequireReads().GetCellLocation(Key, CellFormKey);

        Assert.NotNull(location);
        Assert.Equal("000900:Diagnosed.esp", location.Value.ParentWorldspace);
        Assert.Equal(3, location.Value.BlockX);
        Assert.Equal(2, location.Value.SubY);
        Assert.Null(location.Value.GridX);
        Assert.False(location.Value.IsInterior);
    }

    [Fact]
    public void ACellTheCodecRefuses_StillLandsAPlacementRowPerRefItHolds_WithPositionsUnknown()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");
        var reads = index.RequireReads();

        var persistent = reads.GetPlacement(PersistentRef, Key);
        Assert.NotNull(persistent);
        Assert.Equal(CellFormKey, persistent.Value.ParentCell);
        Assert.Equal("persistent", persistent.Value.PlacementGroup);
        Assert.Null(persistent.Value.PosX);

        var temporary = reads.GetPlacement(TemporaryRef, Key);
        Assert.NotNull(temporary);
        Assert.Equal(CellFormKey, temporary.Value.ParentCell);
        Assert.Equal("temporary", temporary.Value.PlacementGroup);
    }

    // The same fixture with the cell readable, so what the diagnosis costs is legible: the grid and
    // the positions, and nothing else.
    [Fact]
    public void TheSameCellReadable_LandsTheSameRows_WithItsGridAndPositions()
    {
        using var index = Indexed(cellDiagnosis: null);
        var reads = index.RequireReads();

        var location = reads.GetCellLocation(Key, CellFormKey);
        Assert.NotNull(location);
        Assert.Equal(12, location.Value.GridX);
        Assert.Equal(-5, location.Value.GridY);

        var persistent = reads.GetPlacement(PersistentRef, Key);
        Assert.NotNull(persistent);
        Assert.Equal(10f, persistent.Value.PosX);
        Assert.Equal(30f, persistent.Value.PosZ);
    }

    // A temporary ref whose document spells no position: the row carries none rather than the origin.
    [Fact]
    public void ARefWhoseDocumentSpellsNoPosition_LandsWithNullCoordinates()
    {
        using var index = Indexed(cellDiagnosis: null);

        var row = index.RequireReads().GetPlacement(TemporaryRef, Key);

        Assert.NotNull(row);
        Assert.Null(row.Value.PosX);
        Assert.Null(row.Value.PosY);
        Assert.Null(row.Value.PosZ);
    }

    // Hand-built rather than serialized from a mod: no fixture plugin holds a cell the codec refuses,
    // and what is under test is what the ingest does with a diagnosis, not how one arises.
    private sealed class StubbedDocumentsAdapter(string? cellDiagnosis) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null) =>
            new StubDocuments(cellDiagnosis);
    }

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
