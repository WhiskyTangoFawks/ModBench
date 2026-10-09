using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Codec.Tests.TestSupport.DocumentEditing;

namespace MEditService.Codec.Tests.Schema;

public class UnionArrayAddInventoryTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    public static TheoryData<string, string> UnionArrays()
    {
        var data = new TheoryData<string, string>();
        var columns = Schemas
            .OrderBy(table => table.Key, StringComparer.Ordinal)
            .SelectMany(table => table.Value.RecordColumns
                .Where(column => column.Field.ElementType?.Fields?.Any(field => field.IsDiscriminator) == true)
                .Select(column => (Table: table.Key, Column: column.Name, Kinds: KindsOf(column))));
        foreach (var shape in columns.GroupBy(column => column.Kinds, StringComparer.Ordinal))
        {
            var (table, column, _) = shape.OrderByDescending(c => RecordTypes.For(GameRelease.Fallout4).IsCreatable(c.Table)).First();
            data.Add(table, column);
        }
        return data;
    }

    private static string KindsOf(ColumnSpec column) =>
        string.Join("|", column.Field.ElementType.Require().Fields.Require().Single(f => f.IsDiscriminator).EnumMembers.Select(m => m.Value));

    [Theory]
    [MemberData(nameof(UnionArrays))]
    public void ArrayAdd_BuildsAnElementTheCodecAccepts(string table, string column)
    {
        var schema = Schemas[table];
        var bare = RecordMint.BareDocument(schema, GameRelease.Fallout4, "000800:UnionArrayAdd710.esp", editorId: null);
        var col = schema.RecordColumns.Single(c => c.Name == column);

        var after = Edited(bare, table, EditOp.Add, null, Member(column));

        using var document = JsonDocument.Parse(after);
        var written = document.RootElement.GetProperty(col.PropertyName);
        Assert.Equal(1, written.GetArrayLength());
        var discriminator = col.Field.ElementType.Require().Fields.Require().Single(f => f.IsDiscriminator);
        Assert.Equal(
            discriminator.EnumMembers[0].Value,
            written[0].GetProperty(discriminator.Name).GetString());
    }
}
