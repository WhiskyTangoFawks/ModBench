using MEditService.Core.Queries;
using MEditService.Core.Schema;

namespace MEditService.Tests.Query;

public class FieldMetadataMapperTests
{
    private readonly IFieldMetadataMapper _mapper = new FieldMetadataMapper();

    private static ColumnSpec MakeColumn(
        string name,
        string duckDbType,
        string apiType,
        string[]? validFormKeyTypes = null,
        string[]? enumValues = null) =>
        new(name, name, duckDbType, _ => null, apiType,
            validFormKeyTypes ?? [], enumValues ?? [], null);

    [Fact]
    public void Map_BoolColumn_ReturnsBoolApiType()
    {
        var col = MakeColumn("my_flag", "BOOLEAN", "bool");
        var meta = _mapper.Map(col);
        Assert.Equal("my_flag", meta.Name);
        Assert.Equal("bool", meta.Type);
        Assert.False(meta.IsArray);
        Assert.Empty(meta.ValidFormKeyTypes);
        Assert.Empty(meta.EnumValues);
    }

    [Fact]
    public void Map_EnumColumn_ReturnsEnumValuesPassedThrough()
    {
        var values = new[] { "Alpha", "Beta", "Gamma" };
        var col = MakeColumn("my_enum", "VARCHAR", "enum", enumValues: values);
        var meta = _mapper.Map(col);
        Assert.Equal("enum", meta.Type);
        Assert.Equal(values, meta.EnumValues);
    }

    [Fact]
    public void Map_FormKeyColumn_ReturnsValidFormKeyTypesPassedThrough()
    {
        var validTypes = new[] { "race" };
        var col = MakeColumn("race", "VARCHAR", "formKey", validFormKeyTypes: validTypes);
        var meta = _mapper.Map(col);
        Assert.Equal("formKey", meta.Type);
        Assert.Equal(validTypes, meta.ValidFormKeyTypes);
    }

    [Fact]
    public void Map_StringColumn_ReturnsStringApiType()
    {
        var col = MakeColumn("name", "VARCHAR", "string");
        var meta = _mapper.Map(col);
        Assert.Equal("string", meta.Type);
    }
}
