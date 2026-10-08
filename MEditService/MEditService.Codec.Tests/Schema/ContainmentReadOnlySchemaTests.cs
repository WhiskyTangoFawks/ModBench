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
                .Where(c => RecordTypes.For(GameRelease.Fallout4).ChildSlotsOf(schema.TableName).Contains(c.PropertyName))
                .Select(column => (Schema: schema, Column: column)))
            .ToList();
        Assert.Contains(slots, s => s.Schema.TableName == "cell" && s.Column.Name == "NavigationMeshes");
        Assert.Contains(slots, s => s.Schema.TableName == "wrld" && s.Column.Name == "SubCells");

        var writable = slots
            .Where(s => s.Column.Field.ReadOnlyReason?.Contains("not by editing the slot", StringComparison.Ordinal) != true)
            .Select(s => $"{s.Schema.TableName}.{s.Column.Name}");
        Assert.Empty(writable);
    }

    [Fact]
    public void EveryMemberBelowAReadOnlyColumn_IsReadOnly_SoNoPathThroughItEndsWritable()
    {
        Assert.NotEmpty(Column("cell", "Grid").Field.Fields ?? []);
        var writable = Schemas.Values
            .SelectMany(schema => schema.RecordColumns
                .Where(c => c.Field.ReadOnlyReason != null)
                .SelectMany(c => Below(c.Field).Where(m => m.ReadOnlyReason == null).Select(m => $"{schema.TableName}.{c.Name}.{m.Name}")));
        Assert.Empty(writable);

        static IEnumerable<FieldMetadata> Below(FieldMetadata field) =>
            new[] { field.ElementType }.OfType<FieldMetadata>()
                .Concat(field.Fields ?? [])
                .Concat(field.Variants?.Values ?? [])
                .SelectMany(m => Below(m).Prepend(m));
    }

    [Fact]
    public void ACellsGrid_IsReadOnly_AsItsPlaceInTheWorld()
    {
        Assert.Contains(
            "it decides the block and sub-block directories that hold the cell's source",
            Column("cell", "Grid").Field.ReadOnlyReason, StringComparison.Ordinal);
    }

    [Fact]
    public void EveryPlacedRecordsPosition_IsWritable_SinceItsCellComesFromStructureNotFromWhereItSits()
    {
        Assert.Contains("refr", PlacedRecordTables.Names);
        var readOnly = PlacedRecordTables.Fallout4
            .Where(schema => schema.RecordColumns.Single(c => c.Name == "Position").Field.ReadOnlyReason != null)
            .Select(schema => schema.TableName);
        Assert.Empty(readOnly);
    }
}
