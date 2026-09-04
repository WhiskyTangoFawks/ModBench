using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

/// <summary>
/// The key text a keyed array's element reads as. This is a contract across the wire, not an
/// internal detail: the compare grid labels a row with this text, and the webview re-derives it
/// from the same element to work out where that row's element sits in each column's own array
/// (<c>elementKeyText</c>, <c>modbench/webview/src/recordUtils.ts</c>). The two must agree
/// exactly — a disagreement resolves to "no such element" and drops the write silently, which is
/// the failure mode #716 exists to kill.
///
/// <para>Every case below is asserted a second time, against the same element and the same expected
/// text, by <c>recordUtils.test.ts</c>'s own <c>elementKeyText</c> block. Change one side's
/// rendering and that side's table goes red.</para>
/// </summary>
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
    // #710: a freshly added element names its discriminator and nothing else, so its key is empty
    // — a real key, and the only handle on the row until the user names it.
    [InlineData("""{"concrete_type":"ScriptIntProperty"}""", "", "name")]
    [InlineData("""{"name":null}""", "", "name")]
    public void KeyText(string elementJson, string expected, params string[] keyMembers)
    {
        var element = JsonDocument.Parse(elementJson).RootElement;
        Assert.Equal(expected, ElementKey.Of(element, keyMembers).Text);
    }
}
