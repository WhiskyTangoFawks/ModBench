using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

public class ColumnSpecTests
{
    private static ColumnSpec MakeColumn(
        string name = "my_field",
        string apiType = "string",
        bool isArray = false,
        string[]? validFormKeyTypes = null,
        EnumMember[]? enumMembers = null) =>
        new(name, name, "VARCHAR", apiType,
            validFormKeyTypes ?? [], enumMembers ?? [], isArray);

    [Fact]
    public void ToFieldMetadata_MapsAllFields()
    {
        var enums = new EnumMember[] { new("Alpha"), new("Beta"), new("Gamma") };
        var formKeyTypes = new[] { "Race" };
        var col = MakeColumn(name: "some_field", apiType: "enum", isArray: true,
            validFormKeyTypes: formKeyTypes, enumMembers: enums);

        var meta = col.ToFieldMetadata();

        Assert.Equal("some_field", meta.Name);
        Assert.Equal("enum", meta.Type);
        Assert.True(meta.IsArray);
        Assert.Equal(enums, meta.EnumMembers);
        Assert.Equal(formKeyTypes, meta.ValidFormKeyTypes);
    }

    [Fact]
    public void ToFieldMetadata_IsArray_DefaultsFalse()
    {
        Assert.False(MakeColumn().ToFieldMetadata().IsArray);
    }

}
