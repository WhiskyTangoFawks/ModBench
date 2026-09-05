using System.Text.Json;
using MEditService.Core.Queries;

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
    [InlineData("""{"Property":{"Name":"","Alias":3}}""", "3", "property.alias")]
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
}
