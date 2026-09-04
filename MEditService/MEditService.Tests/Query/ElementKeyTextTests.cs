using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

/// <summary>A wire contract: the webview re-derives this text to locate a row's element, and a disagreement
/// drops the write silently (#716).</summary>
public class ElementKeyTextTests
{
    [Theory]
    // A string member.
    [InlineData("""{"name":"Ambush","flags":"Local"}""", "Ambush", "name")]
    // A composite key, joined in the order the annotation lists the members.
    [InlineData("""{"stage":10,"stage_index":0}""", "10 / 0", "stage", "stage_index")]
    // A dotted member name walks into the element's own sub-struct.
    [InlineData("""{"property":{"name":"","alias":3}}""", "3", "property.alias")]
    [InlineData("""{"on":true}""", "true", "on")]
    // A freshly added element names its discriminator and nothing else, so its key is empty: a real
    // key, and the only handle on the row until the user names it.
    [InlineData("""{"concrete_type":"ScriptIntProperty"}""", "", "name")]
    [InlineData("""{"name":null}""", "", "name")]
    public void KeyText(string elementJson, string expected, params string[] keyMembers)
    {
        var element = JsonDocument.Parse(elementJson).RootElement;
        Assert.Equal(expected, ElementKey.Of(element, keyMembers).Text);
    }
}
