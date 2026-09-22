using MEditService.Codec.Schema;
using MEditService.Tests;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

/// <summary>A Color is one text leaf the codec spells as "#AARRGGBB". Whether the alpha byte is the
/// field's to edit is decided per field, not per type (ADR-0018): xEdit renders most as RGB, four
/// as RGBA.</summary>
public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    [Fact]
    public void Color_IsAColorLeaf_WithNoMembersOfItsOwn()
    {
        // Light.Color is `wbByteColors('Color')` in wbDefinitionsFO4.pas:10539.
        var color = Column("ligh", "Color");

        Assert.Equal("color", color.ApiType);
        Assert.Null(color.Field.SubFields);
        Assert.True(color.IsViewable);
    }

    [Fact]
    public void Color_NestedInsideAStruct_IsAColorLeaf()
    {
        // Cell.Lighting -> CellLighting.AmbientColor, one level in — the nested twin of the fact
        // above, proving the leaf kind is reached from BuildSubSchema's dispatch and not only from
        // the top-level column dispatch.
        var lighting = Column("cell", "Lighting");
        var subFields = lighting.Field.SubFields
            ?? throw new InvalidOperationException("Expected 'cell.Lighting' to have sub-fields.");
        var ambient = subFields.Single(f => f.Name == "AmbientColor");

        Assert.Equal("color", ambient.ApiType);
        Assert.Null(ambient.SubFields);
    }
}
