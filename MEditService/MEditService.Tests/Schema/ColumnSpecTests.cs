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
    public void ToFieldMetadata_MapsAllFields()
    {
        var enums = new[] { "Alpha", "Beta", "Gamma" };
        var formKeyTypes = new[] { "race" };
        var col = MakeColumn(name: "some_field", apiType: "enum", isArray: true,
            validFormKeyTypes: formKeyTypes, enumValues: enums);

        var meta = col.ToFieldMetadata();

        Assert.Equal("some_field", meta.Name);
        Assert.Equal("enum", meta.Type);
        Assert.True(meta.IsArray);
        Assert.Equal(enums, meta.EnumValues);
        Assert.Equal(formKeyTypes, meta.ValidFormKeyTypes);
    }

    [Fact]
    public void ToFieldMetadata_IsArray_DefaultsFalse()
    {
        Assert.False(MakeColumn().ToFieldMetadata().IsArray);
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
