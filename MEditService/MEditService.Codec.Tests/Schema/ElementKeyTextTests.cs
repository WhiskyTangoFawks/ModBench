using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public class ElementKeyTextTests
{
    [Theory]
    [InlineData("""{"Name":"Ambush","Flags":"Local"}""", "Name", "Ambush")]
    [InlineData("""{"Stage":10,"StageIndex":0}""", "Stage,StageIndex", "10 / 0")]
    [InlineData("""{"Property":{"Name":"","Alias":3}}""", "Property.Alias", "3")]
    [InlineData("""{"on":true}""", "on", "true")]
    [InlineData("""{"MutagenObjectType":"ScriptIntProperty"}""", "Name", "")]
    [InlineData("""{"Name":null}""", "Name", "")]
    public void AnElementsKey_ReadsAsItsMembersJoinedInTheOrderTheAnnotationListsThem_AnAbsentOrNullOneEmpty(string element, string keyMembers, string text)
    {
        Assert.Equal(text, ElementKey.Of(JsonDocument.Parse(element).RootElement, keyMembers.Split(',')).Text);
    }

    private static readonly FieldMetadata FragmentElement = new("", "struct", false, [], [], Fields:
    [
        new("Stage", "int", false, [], []),
        new("StageIndex", "int", false, [], []),
        new("Flags", "flags", false, [], [new("OnStart", "1"), new("OnCompletion", "2")]),
    ]);

    [Fact]
    public void AnAbsentKeyMember_ReadsAsItsDefault_ForTheCodecOmitsAMemberEqualToItsDefault()
    {
        var omitted = JsonDocument.Parse("""{"Stage":10}""").RootElement;
        var spelled = JsonDocument.Parse("""{"Stage":10,"StageIndex":0}""").RootElement;

        Assert.Equal("10 / 0", ElementKey.Of(omitted, ["Stage", "StageIndex"], FragmentElement).Text);
        Assert.Equal(0, ElementKey.Order.Compare(
            ElementKey.Of(omitted, ["Stage", "StageIndex"], FragmentElement),
            ElementKey.Of(spelled, ["Stage", "StageIndex"], FragmentElement)));
    }

    [Fact]
    public void AnAbsentKeyMember_ReadsAsItsDeclaredDefault()
    {
        var element = new FieldMetadata("", "struct", false, [], [], Fields: [new("Version", "int", false, [], [], Default: 6)]);
        var omitted = JsonDocument.Parse("{}").RootElement;

        Assert.Equal("6", ElementKey.Of(omitted, ["Version"], element).Text);
    }

    [Fact]
    public void AnAbsentNullableKeyMember_KeysApartFromZero()
    {
        var element = new FieldMetadata("", "struct", false, [], [], Fields: [new("Number", "int", false, [], [], AllowsNull: true)]);
        var unset = ElementKey.Of(JsonDocument.Parse("{}").RootElement, ["Number"], element);
        var zero = ElementKey.Of(JsonDocument.Parse("""{"Number":0}""").RootElement, ["Number"], element);

        Assert.NotEqual(0, ElementKey.Order.Compare(unset, zero));
    }

    [Fact]
    public void AFlagsKeyMember_ReadsAsItsNames_AndOrdersByItsBitsAsXEditsWbStructSKDoes()
    {
        var start = JsonDocument.Parse("""{"Flags":["OnStart"]}""").RootElement;
        var completion = JsonDocument.Parse("""{"Flags":["OnCompletion"]}""").RootElement;

        Assert.Equal("OnStart", ElementKey.Of(start, ["Flags"], FragmentElement).Text);
        Assert.True(ElementKey.Order.Compare(
            ElementKey.Of(start, ["Flags"], FragmentElement),
            ElementKey.Of(completion, ["Flags"], FragmentElement)) < 0);
    }
}
