using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public class UnionArrayAddInventoryTests
{
    private const string LandscapeTable = "land";

    private static readonly ModKey Key = ModKey.FromFileName("UnionArrayAdd710.esp");

    public static TheoryData<string, string> UnionArrays()
    {
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var data = new TheoryData<string, string>();
        var columns = schemas
            .OrderBy(table => table.Key, StringComparer.Ordinal)
            .SelectMany(table => table.Value.RecordColumns
                .Where(column => column.Field.ElementType?.Fields?.Any(field => field.IsDiscriminator) == true)
                .Select(column => (Table: table.Key, Column: column.Name, Kinds: KindsOf(column))));
        foreach (var shape in columns.GroupBy(column => column.Kinds, StringComparer.Ordinal))
        {
            var (table, column, _) = shape.OrderByDescending(c => CreatableRecordTypes.Includes(c.Table, GameRelease.Fallout4)).First();
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
        using var fixture = new DocumentEditFixture();
        var formKey = table == LandscapeTable ? fixture.SeedLandscape(new Fallout4Mod(Key, Fallout4Release.Fallout4)) : Created(fixture, table);
        var col = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

        var (result, after) = fixture.Apply(formKey, Envelopes.AddAt(Envelopes.Member(column)));

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(after);
        using var document = JsonDocument.Parse(after);
        var written = document.RootElement.GetProperty(col.PropertyName);
        Assert.Equal(1, written.GetArrayLength());
        var discriminator = col.Field.ElementType.Require().Fields.Require().Single(f => f.IsDiscriminator);
        Assert.Equal(
            discriminator.EnumMembers[0].Value,
            written[0].GetProperty(discriminator.Name).GetString());
    }

    private static string Created(DocumentEditFixture fixture, string table)
    {
        var created = fixture.CreateHandler.CreateRecord(fixture.Plugin, table);
        Assert.True(created.Applied, created.Message);
        return created.NewFormKey.Require();
    }
}
