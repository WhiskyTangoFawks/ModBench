using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;

namespace MEditService.Http.Tests.Api;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class GitMissingApiTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";
    private static readonly object Item = new { name = Plugin, origin = Origin };

    public sealed class Route(string gesture, Func<HttpClient, Task<HttpResponseMessage>> send)
    {
        public string Gesture => gesture;

        public Task<HttpResponseMessage> Send(HttpClient client) => send(client);

        public override string ToString() => gesture;
    }

    public static TheoryData<Route> WholeSelections =>
    [
        new("Delete", client => client.PostAsJsonAsync(
            "/records/delete-changes", new { records = new[] { new { formKey = $"000800:{Plugin}", plugin = Item } } })),
        new("Decompile and repair", client => client.PostAsJsonAsync(
            "/plugins/decompile-and-repair", new { plugins = new[] { new { plugin = Item } }, force = false })),
        new("Version in git", client => client.VersionInGit(Origin)),
        new("Decompile", client => client.Decompile([(Plugin, Origin)])),
        new("Compile", client => client.Compile([(Plugin, Origin)])),
        new("Build", client => client.Build([(Origin, Origin)], new { copy = new[] { "a.nif" } })),
    ];

    [Theory]
    [MemberData(nameof(WholeSelections))]
    public async Task AWholeSelection_WithGitMissing_Is500WithTheRefusal_AndIsLogged(Route route)
    {
        using var fx = new PluginFixtureBuilder("api-without-git").WithPlugin(Plugin, origin: Origin).BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var response = await WithGitMissing(() => route.Send(Client));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning
            && entry.Message.StartsWith($"Refused {route.Gesture}: GitUnavailable", StringComparison.Ordinal));
    }

    private static async Task<HttpResponseMessage> WithGitMissing(Func<Task<HttpResponseMessage>> request)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            return await request();
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }
}
