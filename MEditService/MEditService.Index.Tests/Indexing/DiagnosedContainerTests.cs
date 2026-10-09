using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
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

    private OpenedIndex Indexed(string? cellDiagnosis) =>
        Indexes.Reconciled(_fixture, adapter: new StubbedDocumentsAdapter(cellDiagnosis));

    private static (WorldspaceBlockDto Block, WorldspaceSubBlockDto SubBlock, CellSummary Cell) TheCellOf(OpenedIndex index)
    {
        var block = Assert.Single(index.Worldspaces.GetWorldspaceBlocks(Key, Worldspace).Blocks);
        var subBlock = Assert.Single(block.SubBlocks);
        return (block, subBlock, Assert.Single(subBlock.Cells, c => c.FormKey == CellFormKey));
    }

    [Fact]
    public void ACellTheCodecRefuses_StillLandsItsLocation_WithItsGridUnknown()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");

        var (block, subBlock, cell) = TheCellOf(index);

        Assert.Equal((3, 4, 1, 2), (block.X, block.Y, subBlock.X, subBlock.Y));
        Assert.Null(cell.CellX);
        Assert.Empty(index.Worldspaces.GetInteriorCells(Key));
    }

    [Fact]
    public void ACellTheCodecRefuses_StillListsEachRefItHolds_InItsPlacementGroup()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");

        Assert.Equal("persistent", index.PlacementGroupIn(Key, CellFormKey, PersistentRef));
        Assert.Equal("temporary", index.PlacementGroupIn(Key, CellFormKey, TemporaryRef));
    }

    [Fact]
    public void ACellTheCodecRefuses_StillListsItsLandscapeAndNavmeshesAmongItsTemporaryChildRecords_EachWithItsOwnDiagnosis()
    {
        using var index = Indexed(cellDiagnosis: "the codec refused this cell");

        var temporary = index.Worldspaces.GetCellChildRecords(Key, CellFormKey).Temporary;

        Assert.Equal(
            [(TemporaryRef, "refr", null), (Landscape, "land", null), (Navmesh, "navm", NavmeshDiagnosis)],
            temporary.Select(t => (t.FormKey, t.RecordType, t.ParseDiagnosis)));
    }

    [Fact]
    public void AQuestTheCodecRefuses_StillHoldsItsDialogTopic_WhichIsNotListedAtThePluginRoot()
    {
        using var index = Indexed(cellDiagnosis: null);

        Assert.Equal([Topic], index.Containers.GetChildren(Key, Quest).Select(c => c.FormKey));
        Assert.DoesNotContain(index.Records.GetPluginRecordTypes(Key), group => group.Type == "dial");
    }

    private RecordSummary SearchedInAPluginThatIsNotActive(string formKey)
    {
        var inactive = _fixture.Plugins.Select(p => p with { Enabled = false }).ToList();
        using var index = Indexes.Reconciled(_fixture.DataFolder, inactive, adapter: new StubbedDocumentsAdapter(null));
        return Assert.Single(index.Records.GetRecords(types: null, Key, search: formKey, limit: 50, offset: 0).Items);
    }

    [Fact]
    public void AQuestHoldingATopic_ReportsItsChildren_WhenItsPluginIsNotActive() =>
        Assert.True(SearchedInAPluginThatIsNotActive(Quest).HasContainerChildren);

    [Fact]
    public void ARefusedNavmesh_MarksTheCellAboveIt_WhenItsPluginIsNotActive() =>
        Assert.True(SearchedInAPluginThatIsNotActive(CellFormKey).HasParseFailure);

    [Fact]
    public void ARefusedNavmesh_MarksTheReadableCellAboveIt_WhichCarriesNoDiagnosisOfItsOwn()
    {
        using var index = Indexed(cellDiagnosis: null);

        var (_, _, cell) = TheCellOf(index);

        Assert.True(cell.HasParseFailure);
        Assert.Null(cell.ParseDiagnosis);
    }

    [Fact]
    public void TheSameCellReadable_LandsItsGrid()
    {
        using var index = Indexed(cellDiagnosis: null);

        var (_, _, cell) = TheCellOf(index);

        Assert.Equal<(int?, int?)>((12, -5), (cell.CellX, cell.CellY));
    }

    private sealed class StubbedDocumentsAdapter(string? cellDiagnosis) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override PluginAnswer<IPluginDocuments> OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null) =>
            RequireExtensions.AnswerOf<IPluginDocuments>(() => new StubDocuments(cellDiagnosis));
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
            new PluginDocument("refr", PersistentRef, $$"""{"FormKey": "{{PersistentRef}}"}"""),
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
