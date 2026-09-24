using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

/// <summary>edit-record with git missing from the PATH: a cause no record can escape, so the whole
/// selection is refused once, before any record is written.</summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class EditRecordWithoutGitTraceTests : HostedTests
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
        var npcs = (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("formKey").GetString().Require()).ToArray();
        Assert.Equal(2, npcs.Length);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var before = FilesOutsideGit(modFolder);

        HttpResponseMessage response;
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            response = await Client.PostAsJsonAsync("/records/delete", new
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
    }

    private static SortedDictionary<string, string> FilesOutsideGit(string modFolder) =>
        new(Directory.EnumerateFiles(modFolder, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(modFolder, file))
            .Where(relative => !relative.StartsWith(".git" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .ToDictionary(relative => relative, relative => Convert.ToBase64String(File.ReadAllBytes(Path.Combine(modFolder, relative)))),
            StringComparer.Ordinal);
}
