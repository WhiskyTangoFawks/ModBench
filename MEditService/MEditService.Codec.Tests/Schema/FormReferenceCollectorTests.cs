using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Schema;

public class FormReferenceCollectorTests
{
    private static ColumnSpec Column(FieldMetadata field) => new(field, field.Name);

    private static FieldMetadata Link(string name) => new(name, "formKey", false, [], []);

    private static ColumnSpec StructsOf(string name, params FieldMetadata[] members) =>
        Column(new FieldMetadata(name, "array", true, [], [], ElementType: new FieldMetadata("", "struct", false, [], [], Fields: members)));

    private static readonly Dictionary<string, ColumnSpec> Columns = new(StringComparer.Ordinal)
    {
        ["a link"] = Column(Link("Race")),
        ["a list of links"] = Column(new FieldMetadata("Keywords", "array", true, [], [], ElementType: Link("Keywords"))),
        ["a list of structs holding a link"] = StructsOf("Factions", Link("Faction")),
        ["a list of structs holding two links"] = StructsOf("links", Link("LinkFrom"), Link("LinkTo")),
        ["a list of structs holding a struct holding a link"] = StructsOf("links", new FieldMetadata("inner", "struct", false, [], [], Fields: [Link("Target")])),
        ["a string"] = Column(new FieldMetadata("Name", "string", false, [], [])),
        ["a list of elements the schema could not shape"] = Column(new FieldMetadata("items", "array", true, [], [], ElementType: null)),
    };

    private static string Collected(string column, string member)
    {
        var spec = Columns[column];
        var root = Document.Parse($"{{\"{spec.PropertyName}\": {member}}}");
        return string.Join("; ", FormReferences.Collect(root, [spec]).Select(r => $"{r.FieldPath} = {r.TargetFormKey}"));
    }

    [Theory]
    [InlineData("a link", "\"000001:Fallout4.esm\"", "Race = 000001:Fallout4.esm")]
    [InlineData("a list of links", """["000001:Fallout4.esm","000002:Plugin.esp"]""", "Keywords[0] = 000001:Fallout4.esm; Keywords[1] = 000002:Plugin.esp")]
    [InlineData("a list of links", """[null,"Null","000003:Plugin.esp"]""", "Keywords[2] = 000003:Plugin.esp")]
    [InlineData("a list of links", """[1, "000001:Fallout4.esm", true]""", "Keywords[1] = 000001:Fallout4.esm")]
    [InlineData("a list of structs holding a link", """[{"Faction":"000010:Plugin.esp","Rank":1}]""", "Factions[0].Faction = 000010:Plugin.esp")]
    [InlineData("a list of structs holding a link", """[null, {"Faction":"000010:Plugin.esp"}]""", "Factions[1].Faction = 000010:Plugin.esp")]
    [InlineData("a list of structs holding a link", """["not-an-object", {"Faction":"000010:Plugin.esp"}]""", "Factions[1].Faction = 000010:Plugin.esp")]
    [InlineData(
        "a list of structs holding two links",
        """[{"LinkFrom":"000001:A.esp","LinkTo":"000002:A.esp"},{"LinkFrom":"000003:A.esp","LinkTo":"000004:A.esp"}]""",
        "links[0].LinkFrom = 000001:A.esp; links[0].LinkTo = 000002:A.esp; links[1].LinkFrom = 000003:A.esp; links[1].LinkTo = 000004:A.esp")]
    [InlineData("a list of structs holding a struct holding a link", """[{"inner":{"Target":"000001:Plugin.esp"}}]""", "links[0].inner.Target = 000001:Plugin.esp")]
    public void EveryLinkAColumnHolds_IsCollectedAtItsPath_AndNothingElseIs(string column, string member, string collected)
    {
        Assert.Equal(collected, Collected(column, member));
    }

    [Theory]
    [InlineData("a link", "null")]
    [InlineData("a link", "\"Null\"")]
    [InlineData("a list of structs holding a link", """[{"Faction":"Null"}]""")]
    [InlineData("a list of structs holding a link", """[{"Rank":1}]""")]
    [InlineData("a string", "\"some value\"")]
    [InlineData("a list of elements the schema could not shape", """["000001:Fallout4.esm"]""")]
    public void AColumnHoldingNoLink_YieldsNoReference(string column, string member)
    {
        Assert.Empty(Collected(column, member));
    }

    [Fact]
    public void ARecordWithANestedStruct_AListOfLinks_AndAUnionField_YieldsEachTargetOnce_TheLeafNamedByTheDocumentsOwnDiscriminatorDecidingTheShape()
    {
        var nested = Column(new FieldMetadata("Ownership", "struct", false, [], [],
            Fields: [new FieldMetadata("Owner", "struct", false, [], [],
                Fields: [new FieldMetadata("Faction", "formKey", false, [], [])])]));
        var list = Column(new FieldMetadata("Keywords", "array", true, [], [],
            ElementType: new FieldMetadata("Keywords", "formKey", false, [], [])));
        var union = Column(new FieldMetadata("Value", "struct", false, [], [], Variants: new Dictionary<string, FieldMetadata>
        {
            ["ObjectValue"] = new FieldMetadata("Value", "struct", false, [], [],
                Fields: [new FieldMetadata("Object", "formKey", false, [], [])]),
            ["StringValue"] = new FieldMetadata("Value", "struct", false, [], [],
                Fields: [new FieldMetadata("Text", "string", false, [], [])]),
        }));

        var document = Document.Parse($$"""
            {
              "{{LoquiUnions.UnionTypeDiscriminator}}": "ObjectValue",
              "Ownership": { "Owner": { "Faction": "000001:A.esp" } },
              "Keywords": ["000002:A.esp", "000003:A.esp"],
              "Value": { "Object": "000004:A.esp" }
            }
            """);

        var refs = FormReferences.Collect(document, [nested, list, union]);

        Assert.Equal(
            [("Ownership.Owner.Faction", "000001:A.esp"),
             ("Keywords[0]", "000002:A.esp"),
             ("Keywords[1]", "000003:A.esp"),
             ("Value.Object", "000004:A.esp")],
            refs.Select(r => (r.FieldPath, r.TargetFormKey)));
    }
}
