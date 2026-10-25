using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class GitMissingApiTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";

    [Fact]
    public async Task DeletingSeveralRecords_WithGitMissing_Is500WithTheRefusal()
    {
        using var fx = new PluginFixtureBuilder("trace-delete-without-git")
            .WithPlugin(Plugin, mod => { mod.Npcs.AddNew("FirstNpc"); mod.Npcs.AddNew("SecondNpc"); }, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var npcs = (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("formKey").GetString().Require()).ToArray();
        Assert.Equal(2, npcs.Length);

        var response = await WithGitMissing(() => Client.PostAsJsonAsync("/records/delete-changes", new
        {
            records = npcs.Select(formKey => new { formKey, plugin = new { name = Plugin, origin = Origin } }).ToArray()
        }));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task DecompilingAndRepairing_WithGitMissing_Is500WithTheRefusal()
    {
        var fixture = MalformationFixtures.ShortRegion;
        using var fx = new PluginFixtureBuilder("api-repair-without-git").WithPlugin(fixture.Malformed.FileName, origin: Origin).BuildScattered();
        fixture.Malformed.WriteInto(Path.GetDirectoryName(fx.Plugins.Single().Path).Require());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var plugin = new { name = fixture.Malformed.FileName, origin = Origin };
        var hash = Assert.Single((await (await Client.PostAsJsonAsync("/plugins/repair-previews", new { plugins = new[] { plugin } }))
            .EnsureSuccessStatusCode().Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").EnumerateArray()).GetProperty("hash").GetString();

        var response = await WithGitMissing(() => Client.PostAsJsonAsync("/plugins/decompile-and-repair", new
        {
            plugins = new[] { new { plugin, hash, sourceFolder = Client.SourceFolderSentFor(Origin) } },
            force = false,
        }));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task InitOfASelection_WithGitMissing_Is500WithTheRefusal()
    {
        using var fx = new PluginFixtureBuilder("trace-init-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .WithPlugin("Second.esp", mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var response = await WithGitMissing(() => Client.DecompileAndCommit([Origin, "SecondMod"]));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Refused Decompile and commit", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DecompilingASelection_WithGitMissing_Is500WithTheRefusal()
    {
        using var fx = new PluginFixtureBuilder("trace-decompile-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();

        var response = await WithGitMissing(() => Client.Decompile([(Plugin, Origin)]));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CompilingASelection_WithGitMissing_Is500WithTheRefusal()
    {
        using var fx = new PluginFixtureBuilder("trace-compile-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .WithPlugin("Second.esp", mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit([Origin, "SecondMod"])).EnsureSuccessStatusCode();

        var response = await WithGitMissing(() => Client.Compile([(Plugin, Origin), ("Second.esp", "SecondMod")]));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task BuildingASelection_WithGitMissing_Is500WithTheRefusal()
    {
        using var fx = await SourceMod("trace-build-without-git");
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();

        var response = await WithGitMissing(() => Client.Build([(Origin, modFolder)], Path.Combine(fx.Root, "stat-cache")));

        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Refused Build", StringComparison.Ordinal));
    }

    private async Task<ScatteredFixtureData> SourceMod(string prefix)
    {
        var fx = new PluginFixtureBuilder(prefix)
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
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
