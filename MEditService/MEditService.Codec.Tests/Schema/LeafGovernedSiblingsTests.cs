using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public sealed class LeafGovernedSiblingsTests
{
    private const string Target = "000801:Leaves.esp";

    private static FieldMetadata ModeUsingLinkUnder(string value) =>
        new("Mode", "enum", false, [], [new EnumMember("A"), new EnumMember("B")], Default: "A",
            SiblingsInUse: new Dictionary<string, IReadOnlyList<string>> { ["A"] = value == "A" ? ["Link"] : [], ["B"] = value == "B" ? ["Link"] : [] });

    private static readonly ColumnSpec Data = new(new("Data", "struct", false, [], [], Fields:
    [
        ModeUsingLinkUnder("A") with
        {
            AllowsNull = true,
            Variants = new Dictionary<string, FieldMetadata> { ["LeafA"] = ModeUsingLinkUnder("A"), ["LeafB"] = ModeUsingLinkUnder("B") },
        },
        new("Link", "formKey", false, [], [], AllowsNull: true),
        new(LoquiUnions.UnionTypeDiscriminator, "enum", false, [], [new EnumMember("LeafA"), new EnumMember("LeafB")], IsDiscriminator: true),
    ]), "Data");

    [Fact]
    public void AReference_IsCollected_WhereItsOwnLeafPutsItInUse()
    {
        var record = $$$"""{"Data":{"MutagenObjectType":"LeafB","Mode":"B","Link":"{{{Target}}}"}}""";

        Assert.Equal([new FormReference(Target, "Data.Link")], FormReferences.Collect(record, [Data]));
    }
}
