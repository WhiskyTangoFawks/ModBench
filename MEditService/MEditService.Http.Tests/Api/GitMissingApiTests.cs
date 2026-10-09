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
    public async Task DeletingSeveralRecords_WithGitMissing_RefusesTheWholeSelectionOnce_AndChangesNoFile()
    {
        using var fx = new PluginFixtureBuilder("trace-delete-without-git")
            .WithPlugin(Plugin, mod => { mod.Npcs.AddNew("FirstNpc"); mod.Npcs.AddNew("SecondNpc"); }, origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        var npcs = (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("formKey").GetString().Require()).ToArray();
        Assert.Equal(2, npcs.Length);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var before = FilesOutsideGit(modFolder);

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.PostAsJsonAsync("/records/delete-changes", new
            {
                records = npcs.Select(formKey => new { formKey, plugin = Plugin, origin = Origin }).ToArray(),
            });
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains("PATH", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(before, FilesOutsideGit(modFolder));
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Refused Delete", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CopyingASelection_WithGitMissing_RefusesTheWholeSelectionOnce_AndChangesNoFile()
    {
        using var fx = new PluginFixtureBuilder("trace-copy-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .WithPlugin("Second.esp", mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        (await Client.Track("SecondMod")).EnsureSuccessStatusCode();
        var npc = (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Single().GetProperty("formKey").GetString().Require();
        var modFolders = fx.Plugins.Select(p => Path.GetDirectoryName(p.Path).Require()).ToList();
        var before = modFolders.Select(FilesOutsideGit).ToList();

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.PostAsJsonAsync("/records/copy", new
            {
                records = new[] { new { formKey = npc, plugin = Plugin, origin = Origin } },
                mode = "New",
                destinations = new[] { new { name = "Second.esp", origin = "SecondMod" } },
            });
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Equal(before, modFolders.Select(FilesOutsideGit));
    }

    [Fact]
    public async Task TrackingASelection_WithGitMissing_RefusesTheWholeSelectionOnce_AndWritesNothing()
    {
        using var fx = new PluginFixtureBuilder("trace-track-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .WithPlugin("Second.esp", mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var modFolders = fx.Plugins.Select(p => Path.GetDirectoryName(p.Path).Require()).ToList();
        var before = modFolders.Select(FilesOutsideGit).ToList();

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.Track([Origin, "SecondMod"]);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains("PATH", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.All(modFolders, modFolder => Assert.False(Directory.Exists(Path.Combine(modFolder, ".git"))));
        Assert.Equal(before, modFolders.Select(FilesOutsideGit));
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Refused Track", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DecompilingASelection_WithGitMissing_RefusesTheWholeSelectionOnce_AndChangesNoFile()
    {
        using var fx = new PluginFixtureBuilder("trace-decompile-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var before = FilesOutsideGit(modFolder);

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.Decompile([(Plugin, Origin)]);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains("PATH", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(before, FilesOutsideGit(modFolder));
        Assert.Contains(Logged, entry => entry.Level == LogLevel.Warning && entry.Message.StartsWith("Refused Decompile", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CompilingASelection_WithGitMissing_RefusesTheWholeSelectionOnce_AndChangesNoFile()
    {
        using var fx = new PluginFixtureBuilder("trace-compile-without-git")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .WithPlugin("Second.esp", mod => mod.Npcs.AddNew("SecondNpc"), origin: "SecondMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track([Origin, "SecondMod"])).EnsureSuccessStatusCode();
        var modFolders = fx.Plugins.Select(p => Path.GetDirectoryName(p.Path).Require()).ToList();
        var before = modFolders.Select(FilesOutsideGit).ToList();

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.Compile([(Plugin, Origin), ("Second.esp", "SecondMod")]);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
        Assert.Contains("PATH", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(before, modFolders.Select(FilesOutsideGit));
    }

    [Fact]
    public async Task EditingARecord_WithGitMissing_Is500_AndChangesNoFile()
    {
        using var fx = await TrackedMod("trace-edit-without-git");
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var before = FilesOutsideGit(modFolder);

        var response = await WithGitMissing(() => Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75));

        await AssertRefusedGitUnavailable(response);
        Assert.Equal(before, FilesOutsideGit(modFolder));
    }

    [Fact]
    public async Task AskingForAnEditsChanges_WithGitMissing_Is500_AsTheEditIs()
    {
        using var fx = await TrackedMod("trace-edit-changes-without-git");
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        var response = await WithGitMissing(() => Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 0.75, "{}"));

        await AssertRefusedGitUnavailable(response);
    }

    [Fact]
    public async Task CreatingARecord_WithGitMissing_Is500_AndChangesNoFile()
    {
        using var fx = await TrackedMod("trace-create-record-without-git");
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var before = FilesOutsideGit(modFolder);

        var response = await WithGitMissing(() => Client.PostAsJsonAsync(
            $"/plugins/{Plugin}/records", new { origin = Origin, recordType = "npc_" }));

        await AssertRefusedGitUnavailable(response);
        Assert.Equal(before, FilesOutsideGit(modFolder));
    }

    private async Task<ScatteredFixtureData> TrackedMod(string prefix)
    {
        var fx = new PluginFixtureBuilder(prefix)
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("FirstNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
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

    private static async Task AssertRefusedGitUnavailable(HttpResponseMessage response)
    {
        var problem = await response.AssertIsProblem(HttpStatusCode.InternalServerError);
        Assert.Equal("GitUnavailable", problem.GetProperty("refusal").GetString());
    }

    private static SortedDictionary<string, string> FilesOutsideGit(string modFolder) =>
        new(Directory.EnumerateFiles(modFolder, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(modFolder, file))
            .Where(relative => !relative.StartsWith(".git" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .ToDictionary(relative => relative, relative => Convert.ToBase64String(File.ReadAllBytes(Path.Combine(modFolder, relative)))),
            StringComparer.Ordinal);
}
