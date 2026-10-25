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

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void NoContainersColumn_IsAChildSlot_SinceEachChildIsARecordOfItsOwn(GameRelease release)
    {
        var types = RecordTypes.For(release);
        var containers = SharedSchemaReflector.Instance.GetSchemas(release).Values.Where(schema => types.HasChildSlots(schema.TableName)).ToList();
        Assert.Contains(containers, schema => types.IsCell(schema.TableName));

        Assert.Empty(containers.SelectMany(schema => schema.RecordColumns
            .Where(c => types.ChildSlotsOf(schema.TableName).Contains(c.PropertyName))
            .Select(c => $"{schema.TableName}.{c.Name}")));
    }

    [Fact]
    public void EveryMemberBelowAReadOnlyColumn_IsReadOnly_SoNoPathThroughItEndsWritable()
    {
        Assert.NotEmpty(Column("cell", "Grid").Field.Fields ?? []);
        var writable = Schemas.Values
            .SelectMany(schema => schema.RecordColumns
                .Where(c => c.Field.ReadOnlyReason != null)
                .SelectMany(c => SchemaFields.Below($"{schema.TableName}.{c.Name}", c.Field).Where(m => m.Field.ReadOnlyReason == null).Select(m => m.Path)));
        Assert.Empty(writable);
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
