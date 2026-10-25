using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class CompareFromContainerTextTests : IDisposable
{
    private static readonly PluginAddress Plugin = new("Tree.esp", "TreeMod");

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly Cell _room;
    private readonly PlacedObject _placed;
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggerFactory;

    public CompareFromContainerTextTests()
    {
        Cell? room = null;
        PlacedObject? placed = null;
        _fixture = new PluginFixtureBuilder("medit-compare-container-text")
            .WithPlugin(Plugin.Name, mod =>
            {
                placed = new PlacedObject(mod) { EditorID = "Placed", Scale = 1f };
                room = new Cell(mod) { EditorID = "Room" };
                room.Temporary.Add(placed);
                mod.AddInteriorCells(room);
            }, origin: Plugin.Origin)
            .BuildScattered()
            .CompiledPlugin();
        (_room, _placed) = (room.Require(), placed.Require());
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));
        _index = Indexes.Reconciled(_fixture, loggerFactory: _loggerFactory);
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggerFactory.Dispose();
        _fixture.Dispose();
    }

    private static string TextOf(IMajorRecordGetter record) => RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);

    private string RoomDocument =>
        _index.Queries.GetCopyDocument(Plugin, _room.FormKey.ToString()).Value()?.Location
            ?? throw new InvalidOperationException("Expected the room's document in the tree.");

    private CompareOverride ColumnReadFrom(IMajorRecordGetter record, string text) =>
        (_index.Queries.GetCompare(record.FormKey.ToString(), new CopyText(Plugin, text)).Value()
            ?? throw new InvalidOperationException("Expected the record to compare.")).Overrides.Single();

    private void AnotherRoomCarryingThePlacedObject()
    {
        var otherRoom = new Cell(new FormKey(_room.FormKey.ModKey, 0xA00), Fallout4Release.Fallout4) { EditorID = "OtherRoom" };
        otherRoom.Temporary.Add(_placed);
        var block = Path.GetDirectoryName(Path.GetDirectoryName(RoomDocument)).Require();
        var otherDocument = PluginSourceRoot.ContainerDocument(Path.Combine(block, PluginSourceRoot.Leaf(otherRoom)));
        Directory.CreateDirectory(Path.GetDirectoryName(otherDocument).Require());
        File.WriteAllText(otherDocument, TextOf(otherRoom));
    }

    [Fact]
    public void ARecordsColumn_IsReadFromItsOwnText()
    {
        _room.EditorID = "EditedRoom";

        var column = ColumnReadFrom(_room, TextOf(_room));

        Assert.Equal(("EditedRoom", null), (column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AChildsColumn_IsReadFromItsContainersText()
    {
        _placed.EditorID = "Edited";
        _placed.Scale = 2.5f;

        var compare = _index.Queries.GetCompare(_placed.FormKey.ToString(), new CopyText(Plugin, TextOf(_room))).Value()
            ?? throw new InvalidOperationException("Expected the child to compare.");

        Assert.Equal(("Edited", null), (compare.Overrides.Single().EditorId, compare.Overrides.Single().ParseDiagnosis));
        Assert.Equal("2.5", compare.Diffs.Single(d => d.FieldName == "Scale").Values["Tree.esp|TreeMod"]?.ToString());
    }

    [Fact]
    public void AChildNoDocumentInTheTreeCarries_IsAColumnSayingSo_NotItsContainerReadAsIt()
    {
        File.Delete(RoomDocument);

        var column = ColumnReadFrom(_placed, TextOf(_room));

        Assert.Equal(
            (_placed.FormKey.ToString(), (string?)null, $"No document in Tree.esp's source tree carries {_placed.FormKey}."),
            (column.FormKey, column.EditorId, column.ParseDiagnosis));
    }

    [Fact]
    public void AChildTheTreeRefusesToRead_IsAColumnWithTheRefusal_NamedOnTheOutputWithItsCause()
    {
        AnotherRoomCarryingThePlacedObject();
        lock (_log) _log.Clear();

        var column = ColumnReadFrom(_placed, TextOf(_room));

        Assert.Contains("OtherRoom - 000A00_Tree.esp", column.ParseDiagnosis, StringComparison.Ordinal);
        LogEntry warning;
        lock (_log) warning = Assert.Single(_log, e => e.Level == LogLevel.Warning);
        Assert.Contains(_placed.FormKey.ToString(), warning.Message, StringComparison.Ordinal);
        Assert.Contains(column.ParseDiagnosis.Require(), warning.Message, StringComparison.Ordinal);
    }
}
