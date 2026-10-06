using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class CompareFromContainerTextTests : IDisposable
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress Plugin = new("Tree.esp", "TreeMod");
    private static readonly string[] Fields = ["Scale"];

    private readonly ScratchDirectory _modFolder = new("medit-compare-container-text-");
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(Plugin.Name), Fallout4Release.Fallout4);
    private readonly Cell _room;
    private readonly PlacedObject _placed;
    private readonly Worldspace _world;
    private readonly PlacedObject _topCellRef;
    private readonly RecordQueryService _service;

    public CompareFromContainerTextTests()
    {
        _placed = new PlacedObject(_mod) { EditorID = "Placed", Scale = 1f };
        _room = new Cell(_mod) { EditorID = "Room" };
        _room.Temporary.Add(_placed);
        _topCellRef = new PlacedObject(_mod) { EditorID = "TopCellRef", Scale = 1f };
        var topCell = new Cell(_mod) { EditorID = "TopCell" };
        topCell.Temporary.Add(_topCellRef);
        _world = new Worldspace(_mod) { EditorID = "World", TopCell = topCell };

        var root = PluginSourceRoot.For(Plugin.Name);
        SourceRepository.Track(_modFolder, [(
            [
                new TreeFile(PluginSourceRoot.ContainerDocument(Path.Combine(root, "Cells", "0", "0", Leaf(_room))), Bytes(_room)),
                new TreeFile(PluginSourceRoot.ContainerDocument(Path.Combine(root, "Worldspaces", Leaf(_world))), Bytes(_world)),
            ],
            new DecompiledPlugin(Plugin.Name, null))]);

        var rows = new[]
        {
            Row(_room, "cell"), Row(_placed, "refr"), Row(_world, "wrld"), Row(topCell, "cell"), Row(_topCellRef, "refr"),
        };
        _service = new RecordQueryService(
            new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), rows) { TextFieldNames = Fields }),
            FakeLoadOrder.Of(Release,
                new LoadOrderEntry(Plugin.Name, Path.Combine(_modFolder, Plugin.Name), Plugin.Origin, 0, Enabled: true, Winning: true)),
            SharedSchemaReflector.Instance);
    }

    public void Dispose() => _modFolder.Dispose();

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private static byte[] Bytes(IMajorRecordGetter record) => Encoding.UTF8.GetBytes(RealDocuments.BodyOf(record, Release));

    private static FakeRow Row(IMajorRecordGetter record, string recordType) =>
        new(Plugin, 0, true, RealDocuments.Of(record, Plugin, 0, true, Release, recordType, Fields));

    private CompareOverride ColumnReadFrom(IMajorRecordGetter record, string text) =>
        (_service.GetCompare(record.FormKey.ToString(), new CopyText(Plugin, text))
            ?? throw new InvalidOperationException("Expected the record to compare.")).Overrides.Single();

    [Fact]
    public void ARecordsColumn_IsReadFromItsOwnText()
    {
        _room.EditorID = "EditedRoom";

        var column = ColumnReadFrom(_room, RealDocuments.BodyOf(_room, Release));

        Assert.Equal(("EditedRoom", null), (column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AChildsColumn_IsReadFromItsContainersText()
    {
        _placed.EditorID = "Edited";
        _placed.Scale = 2.5f;

        var compare = _service.GetCompare(_placed.FormKey.ToString(), new CopyText(Plugin, RealDocuments.BodyOf(_room, Release)))
            ?? throw new InvalidOperationException("Expected the child to compare.");

        Assert.Equal(("Edited", null), (compare.Overrides.Single().EditorId, compare.Overrides.Single().ParseDiagnosis));
        Assert.Equal("2.5", compare.Diffs.Single(d => d.FieldName == "Scale").Values[ColumnKey.Of(Plugin.Name, Plugin.Origin)]?.ToString());
    }

    [Fact]
    public void AChildNestedTwoDeep_IsReadFromItsContainersText()
    {
        _topCellRef.EditorID = "EditedTopCellRef";

        var column = ColumnReadFrom(_topCellRef, RealDocuments.BodyOf(_world, Release));

        Assert.Equal(("EditedTopCellRef", null), (column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AChildIsReadFromItsContainersText_WhoseFormKeyTheTextChangedToOneNothingHolds()
    {
        _placed.EditorID = "Edited";
        var text = RealDocuments.BodyOf(_room, Release).Replace(_room.FormKey.ToString(), "000FFF:Tree.esp", StringComparison.Ordinal);

        var column = ColumnReadFrom(_placed, text);

        Assert.Equal(("Edited", null), (column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AContainersTextThatNoLongerCarriesTheChild_IsAColumnWithTheEditsRefusal()
    {
        _room.Temporary.Clear();

        var column = ColumnReadFrom(_placed, RealDocuments.BodyOf(_room, Release));

        Assert.Equal((_placed.FormKey.ToString(), (string?)null), (column.FormKey, column.EditorId));
        Assert.Contains($"does not carry {_placed.FormKey}", column.ParseDiagnosis, StringComparison.Ordinal);
    }

    [Fact]
    public void AChildTwoDocumentsCarry_IsAColumnWithTheEditsRefusal()
    {
        var otherRoom = new Cell(_mod) { EditorID = "OtherRoom" };
        otherRoom.Temporary.Add(_placed);
        var otherDocument = Path.Combine(
            _modFolder, PluginSourceRoot.ContainerDocument(Path.Combine(PluginSourceRoot.For(Plugin.Name), "Cells", "0", "0", Leaf(otherRoom))));
        Directory.CreateDirectory(Path.GetDirectoryName(otherDocument).Require());
        File.WriteAllBytes(otherDocument, Bytes(otherRoom));

        var column = ColumnReadFrom(_placed, RealDocuments.BodyOf(_room, Release));

        Assert.Contains(Leaf(otherRoom), column.ParseDiagnosis, StringComparison.Ordinal);
    }
}
