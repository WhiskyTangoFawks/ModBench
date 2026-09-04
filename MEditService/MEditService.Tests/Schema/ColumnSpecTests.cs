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
        new(name, name, "VARCHAR", _ => null, apiType,
            validFormKeyTypes ?? [], enumMembers ?? [], LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"), isArray);

    [Fact]
    public void ToFieldMetadata_MapsAllFields()
    {
        var enums = new EnumMember[] { new("Alpha"), new("Beta"), new("Gamma") };
        var formKeyTypes = new[] { "race" };
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

    [Fact]
    public void ToFieldMetadata_PassesThroughEachMembersBit()
    {
        var members = new EnumMember[] { new("A", "1"), new("B", "2"), new("C", "4") };
        var col = new ColumnSpec("flags", "Flags", "BIGINT", _ => null, "enum",
            [], members,
            LeafWrite.ReadOnly<IMajorRecord>("test fixture: write capability is not under test"));
        Assert.Equal(members, col.ToFieldMetadata().EnumMembers);
        Assert.True(col.ToFieldMetadata().IsBitmask);
    }

    [Fact]
    public void ToFieldMetadata_MembersWithNoBit_IsNotABitmask()
    {
        var col = MakeColumn(apiType: "enum", enumMembers: [new("X"), new("Y")]);
        Assert.False(col.ToFieldMetadata().IsBitmask);
    }
}
