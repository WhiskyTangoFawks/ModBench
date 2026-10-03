using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Indexing;

public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    [Fact]
    public void Color_IsAColorLeaf_WithNoMembersOfItsOwn_AsXEditDefinesLightColorAsWbByteColors()
    {
        var color = Column("ligh", "Color");

        Assert.Equal("color", color.ApiType);
        Assert.Null(color.Field.SubFields);
        Assert.True(color.IsViewable);
    }

    [Fact]
    public void Color_NestedInsideAStruct_IsAColorLeaf_ReachedFromBuildSubSchemaDispatchNotOnlyTheTopLevelColumnDispatch()
    {
        var lighting = Column("cell", "Lighting");
        var subFields = lighting.Field.SubFields
            ?? throw new InvalidOperationException("Expected 'cell.Lighting' to have sub-fields.");
        var ambient = subFields.Single(f => f.Name == "AmbientColor");

        Assert.Equal("color", ambient.ApiType);
        Assert.Null(ambient.SubFields);
    }
}
