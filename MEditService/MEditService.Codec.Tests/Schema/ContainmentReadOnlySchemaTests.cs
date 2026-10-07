using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class ContainmentReadOnlySchemaTests
{
    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static ColumnSpec Column(string table, string column) =>
        Schemas[table].RecordColumns.Single(c => c.Name == column);

    [Fact]
    public void EveryContainersChildSlotColumn_IsReadOnly_SinceAChildHasGesturesOfItsOwn()
    {
        var slots = Schemas.Values
            .SelectMany(schema => schema.RecordColumns
                .Where(c => ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType)?.Contains(c.PropertyName) == true)
                .Select(column => (Schema: schema, Column: column)))
            .ToList();
        Assert.Contains(slots, s => s.Schema.TableName == "cell" && s.Column.Name == "NavigationMeshes");
        Assert.Contains(slots, s => s.Schema.TableName == "wrld" && s.Column.Name == "SubCells");

        var writable = slots
            .Where(s => s.Column.ReadOnlyReason?.Contains("not by editing the slot", StringComparison.Ordinal) != true)
            .Select(s => $"{s.Schema.TableName}.{s.Column.Name}");
        Assert.Empty(writable);
    }

    [Fact]
    public void ACellsGrid_IsReadOnly_AsItsPlaceInTheWorld()
    {
        Assert.Contains(
            "it decides the block and sub-block directories that hold the cell's source",
            Column("cell", "Grid").ReadOnlyReason, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryPlacedRecordsPosition_IsReadOnly_AndAPositionOnARecordNotPlacedIsNot()
    {
        Assert.Contains("refr", PlacedRecordTables.Names);
        var writable = PlacedRecordTables.Fallout4
            .Where(schema => schema.RecordColumns.Single(c => c.Name == "Position").ReadOnlyReason?
                .Contains("which cell holds", StringComparison.Ordinal) != true)
            .Select(schema => schema.TableName);
        Assert.Empty(writable);

        Assert.Null(Column("trns", "Position").ReadOnlyReason);
    }
}
