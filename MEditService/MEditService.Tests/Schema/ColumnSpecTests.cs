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

    [Theory]
    // A member with no bit is not a checkbox, so a field is a bitmask only when every one of its
    // members carries one. "Every" over no members at all is vacuously true and would make an
    // empty-domain enum (Fallout 4's NoneProperty) a bitmask, which is why the count is guarded.
    [InlineData("no member carries a bit")]
    [InlineData("only some members carry a bit")]
    [InlineData("there are no members at all")]
    public void ToFieldMetadata_IsNotABitmaskWhen(string shape)
    {
        EnumMember[] members = shape switch
        {
            "no member carries a bit" => [new("X"), new("Y")],
            "only some members carry a bit" => [new("X", "1"), new("Y")],
            _ => [],
        };
        Assert.False(MakeColumn(apiType: "enum", enumMembers: members).ToFieldMetadata().IsBitmask);
    }
}
