using System.Text.Json;
using MEditService.Core.Schema;

namespace MEditService.Tests.Query;

/// <summary>A wire contract: the webview re-derives this text to locate a row's element, and a disagreement
/// drops the write silently.</summary>
public class ElementKeyTextTests
{
    [Theory]
    // A string member.
    [InlineData("""{"Name":"Ambush","Flags":"Local"}""", "Ambush", "Name")]
    // A composite key, joined in the order the annotation lists the members.
    [InlineData("""{"Stage":10,"StageIndex":0}""", "10 / 0", "Stage", "StageIndex")]
    // A dotted member name walks into the element's own sub-struct.
    [InlineData("""{"Property":{"Name":"","Alias":3}}""", "3", "Property.Alias")]
    [InlineData("""{"on":true}""", "true", "on")]
    // A freshly added element names its discriminator and nothing else, so its key is empty: a real
    // key, and the only handle on the row until the user names it.
    [InlineData("""{"MutagenObjectType":"ScriptIntProperty"}""", "", "Name")]
    [InlineData("""{"Name":null}""", "", "Name")]
    public void KeyText(string elementJson, string expected, params string[] keyMembers)
    {
        var element = JsonDocument.Parse(elementJson).RootElement;
        Assert.Equal(expected, ElementKey.Of(element, keyMembers).Text);
    }

    private static readonly FieldMetadata FragmentElement = new("", "struct", false, [], [], Fields:
    [
        new("Stage", "int", false, [], []),
        new("StageIndex", "int", false, [], []),
        new("Flags", "flags", false, [], [new("OnStart", "1"), new("OnCompletion", "2")]),
    ]);

    // The codec omits a member equal to its default, so an element carrying no StageIndex is the
    // same key as one spelling out 0.
    [Fact]
    public void AnAbsentKeyMember_ReadsAsItsDefault()
    {
        var omitted = JsonDocument.Parse("""{"Stage":10}""").RootElement;
        var spelled = JsonDocument.Parse("""{"Stage":10,"StageIndex":0}""").RootElement;

        Assert.Equal("10 / 0", ElementKey.Of(omitted, ["Stage", "StageIndex"], FragmentElement).Text);
        Assert.Equal(0, ElementKey.Of(omitted, ["Stage", "StageIndex"], FragmentElement).CompareTo(
            ElementKey.Of(spelled, ["Stage", "StageIndex"], FragmentElement)));
    }

    // A key member with a declared default above zero reads as that default when absent.
    [Fact]
    public void AnAbsentKeyMember_ReadsAsItsDeclaredDefault()
    {
        var element = new FieldMetadata("", "struct", false, [], [], Fields: [new("Version", "int", false, [], [], Default: 6)]);
        var omitted = JsonDocument.Parse("{}").RootElement;

        Assert.Equal("6", ElementKey.Of(omitted, ["Version"], element).Text);
    }

    // A flags member keys by the names the document carries and orders by their bits, as xEdit's
    // wbStructSK does, so OnStart (1) precedes OnCompletion (2) whatever the names' own order.
    [Fact]
    public void AFlagsKeyMember_ReadsAsItsNames_AndOrdersByItsBits()
    {
        var start = JsonDocument.Parse("""{"Flags":["OnStart"]}""").RootElement;
        var completion = JsonDocument.Parse("""{"Flags":["OnCompletion"]}""").RootElement;

        Assert.Equal("OnStart", ElementKey.Of(start, ["Flags"], FragmentElement).Text);
        Assert.True(ElementKey.Of(start, ["Flags"], FragmentElement).CompareTo(
            ElementKey.Of(completion, ["Flags"], FragmentElement)) < 0);
    }
}
