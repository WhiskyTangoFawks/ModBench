using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class PluginSourceNamesApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private const string Text = """{ "FormKey": "000801:Mod.esp", "Race": "000802:Base.esm" }""";

    private Task<HttpResponseMessage> NamesOf(object request) => loaded.Client.PostAsJsonAsync("/plugin-source/names", request);

    [Fact]
    public async Task TheNamesAtAnOffset_AreAnsweredWithTheirKindAndSpan()
    {
        var response = await NamesOf(new { text = Text, at = Text.IndexOf("Base.esm", StringComparison.Ordinal) });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(
            [("Record", "\"000802:Base.esm\""), ("Plugin", "Base.esm")],
            (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
                .Select(name => (name.GetProperty("kind").GetString(), Text[name.GetProperty("start").GetInt32()..name.GetProperty("end").GetInt32()])));
    }

    public static TheoryData<string, object> Refused => new()
    {
        { "a file named by no absolute path", new { text = Text, path = "plugin-source/Mod.esp/Record.json" } },
        { "an offset outside the text", new { text = Text, at = Text.Length + 1 } },
    };

    [Theory]
    [MemberData(nameof(Refused))]
    public async Task ARequestNamingNoPlaceInTheText_Is400(string _, object request)
    {
        await (await NamesOf(request)).AssertIsProblem(HttpStatusCode.BadRequest);
    }
}
