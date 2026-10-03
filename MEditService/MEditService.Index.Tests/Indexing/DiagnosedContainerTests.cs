using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class DiagnosedContainerTests : IDisposable
{
    private const string Plugin = "Diagnosed.esp";
    private const string Worldspace = "000900:Diagnosed.esp";
    private const string CellFormKey = "000800:Diagnosed.esp";
    private const string PersistentRef = "000801:Diagnosed.esp";
    private const string TemporaryRef = "000802:Diagnosed.esp";
    private const string Landscape = "000803:Diagnosed.esp";
    private const string Navmesh = "000804:Diagnosed.esp";
    private const string NavmeshDiagnosis = "the codec refused this navmesh";
    private const string Quest = "000805:Diagnosed.esp";
    private const string Topic = "000806:Diagnosed.esp";
    private static readonly PluginAddress Key = new(Plugin, PluginOrigin.DataDirectory);

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
        Assert.Equal(Worldspace, location.Value.ParentWorldspace);
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

    [Fact]
    public void ACellTheCodecRefuses_StillListsItsLandscapeAndNavmeshesAmongItsTemporaryChildRecords_EachWithItsOwnDiagnosis()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");

        var temporary = index.RequireReads().GetCellChildRecords(Key, CellFormKey).Temporary;

        Assert.Equal(
            [(TemporaryRef, "refr", null), (Landscape, "land", null), (Navmesh, "navm", NavmeshDiagnosis)],
            temporary.Select(t => (t.FormKey, t.RecordType, t.ParseDiagnosis)));
    }

    [Fact]
    public void AQuestTheCodecRefuses_StillHoldsItsDialogTopic_WhichIsNotListedAtThePluginRoot()
    {
        using var index = Indexed(cellDiagnosis: null);
        var reads = index.RequireReads();

        Assert.Equal([Topic], reads.GetContainerChildren(Key, Quest).Select(c => c.ChildFormKey));
        Assert.DoesNotContain(reads.GetRecordTypeCounts(Key), group => group.Type == "dial");
    }

    [Fact]
    public void ARefusedNavmesh_MarksTheReadableCellAboveIt_WhichCarriesNoDiagnosisOfItsOwn()
    {
        using var index = Indexed(cellDiagnosis: null);

        var cell = index.RequireReads().GetWorldspaceCells(Key, Worldspace).Single();

        Assert.True(cell.HasParseFailure);
        Assert.Null(cell.ParseDiagnosis);
    }

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
              ],
              "Landscape": {
                "FormKey": "000803:Diagnosed.esp"
              },
              "NavigationMeshes": [
                {
                  "FormKey": "000804:Diagnosed.esp"
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
                new CellStructure(Worldspace, 3, 4, 1, 2, IsInterior: false),
                [
                    new ChildRecord(PersistentRef, "Persistent", 0), new ChildRecord(TemporaryRef, "Temporary", 0),
                    new ChildRecord(Landscape, "Landscape", 0), new ChildRecord(Navmesh, "NavigationMeshes", 0),
                ]),
            new PluginDocument("refr", TemporaryRef, $$"""{"FormKey": "{{TemporaryRef}}"}"""),
            new PluginDocument("land", Landscape, $$"""{"FormKey": "{{Landscape}}"}"""),
            new PluginDocument("navm", Navmesh, $$"""{"FormKey": "{{Navmesh}}"}""", NavmeshDiagnosis),
            new PluginDocument(
                "qust", Quest, $$"""{"FormKey": "{{Quest}}"}""", "the codec refused this quest",
                Contents: [new ChildRecord(Topic, "DialogTopics", 0)]),
            new PluginDocument("dial", Topic, $$"""{"FormKey": "{{Topic}}"}"""),
        ];

        public void Dispose()
        {
        }
    }
}
