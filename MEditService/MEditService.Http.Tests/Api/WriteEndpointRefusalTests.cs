using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class WriteEndpointRefusalTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private const string ARecord = """{"formKey": "000800:TestPlugin.esp", "plugin": {"name": "TestPlugin.esp", "origin": "Data/"}}""";

    public static TheoryData<string, string, string> NotAWrite => new()
    {
        { "/records/delete-changes", "no records", """{"records": []}""" },
        {
            "/records/delete-changes", "a record with no origin",
            """{"records": [{"formKey": "000800:TestPlugin.esp", "plugin": {"name": "TestPlugin.esp", "origin": ""}}]}"""
        },
        { "/records/copy-changes", "no destination", $$"""{"records": [{{ARecord}}], "mode": "Override", "destinations": []}""" },
        {
            "/records/copy-changes", "a copy as new that replaces",
            $$"""{"records": [{{ARecord}}], "mode": "New", "destinations": [{"name": "TestPlugin.esp", "origin": "Data/"}], "replace": true}"""
        },
    };

    [Theory]
    [MemberData(nameof(NotAWrite))]
    public async Task AWriteThatCannotBeMade_IsABadRequest(string route, string lacking, string body)
    {
        var response = await loaded.Client.PostJson(route, body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
    }
}
