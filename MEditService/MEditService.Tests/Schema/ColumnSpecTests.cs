using MEditService.Core.Schema;

namespace MEditService.Tests.Schema;

public class ColumnSpecTests
{
    private static ColumnSpec MakeColumn(
        string name = "my_field",
        string apiType = "string",
        bool isArray = false,
        string[]? validFormKeyTypes = null,
        string[]? enumValues = null) =>
        new(name, name, "VARCHAR", _ => null, apiType,
            validFormKeyTypes ?? [], enumValues ?? [], null, isArray);

    [Fact]
    public void ToFieldMetadata_MapsNameAndApiType()
    {
        var col = MakeColumn(name: "some_field", apiType: "string");
        var meta = col.ToFieldMetadata();
        Assert.Equal("some_field", meta.Name);
        Assert.Equal("string", meta.Type);
    }

    [Fact]
    public void ToFieldMetadata_IsArray_ReflectsColumnProperty()
    {
        var col = MakeColumn(isArray: true);
        var meta = col.ToFieldMetadata();
        Assert.True(meta.IsArray);
    }

    [Fact]
    public void ToFieldMetadata_IsArray_DefaultsFalse()
    {
        var col = MakeColumn();
        var meta = col.ToFieldMetadata();
        Assert.False(meta.IsArray);
    }

    [Fact]
    public void ToFieldMetadata_PassesThroughEnumValues()
    {
        var values = new[] { "Alpha", "Beta", "Gamma" };
        var col = MakeColumn(apiType: "enum", enumValues: values);
        var meta = col.ToFieldMetadata();
        Assert.Equal(values, meta.EnumValues);
    }

    [Fact]
    public void ToFieldMetadata_PassesThroughValidFormKeyTypes()
    {
        var types = new[] { "race" };
        var col = MakeColumn(apiType: "formKey", validFormKeyTypes: types);
        var meta = col.ToFieldMetadata();
        Assert.Equal(types, meta.ValidFormKeyTypes);
    }

    [Fact]
    public void ToFieldMetadata_PassesThroughEnumBitValues()
    {
        var bits = new string[] { "1", "2", "4" };
        var col = new ColumnSpec("flags", "Flags", "BIGINT", _ => null, "enum",
            [], ["A", "B", "C"], null,
            IsBitmask: true, EnumBitValues: bits);
        Assert.Equal(bits, col.ToFieldMetadata().EnumBitValues);
    }

    [Fact]
    public void ToFieldMetadata_NonBitmask_EnumBitValuesIsNull()
    {
        var col = MakeColumn(apiType: "enum", enumValues: ["X", "Y"]);
        Assert.Null(col.ToFieldMetadata().EnumBitValues);
    }
}
