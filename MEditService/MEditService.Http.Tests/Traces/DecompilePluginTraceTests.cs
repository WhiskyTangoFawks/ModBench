using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class DecompilePluginTraceTests : HostedTests
{
    private const string Plugin = "CompiledPlugin.esp";
    private const string Origin = "SourceMod";
    private const string Npc = "CompiledPluginNpc";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-decompile-plugin")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task Loaded() => (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task DecompilingACompiledPluginWhoseBytesChanged_AnswersItApplied_AndItsNewSourceReachesTheAnswers()
    {
        await Loaded();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        OtherTool.WritesThePlugin(Path.Combine(OtherTool.ModFolderOf(_instance, Origin), Plugin), mod => mod.Npcs.AddNew("UpgradedNpc"));

        var decompiled = await Client.Decompile([(Plugin, Origin)]);

        decompiled.EnsureSuccessStatusCode();
        var body = await decompiled.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([Plugin], body.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        await Client.NextSnapshot(_instance);
        await Wire.Eventually(async () => await EditorIdUnlessTheIndexIsReconciling(formKey) == "UpgradedNpc", "the decompiled source reaching the answers");
    }

    private async Task<string?> EditorIdUnlessTheIndexIsReconciling(string formKey)
    {
        using var response = await Client.GetAsync($"/records/{Uri.EscapeDataString(formKey)}");
        if (response.StatusCode == HttpStatusCode.ServiceUnavailable) return null;
        return (await response.EnsureSuccessStatusCode().Body()).GetProperty("editorId").GetString();
    }

    [Fact]
    public async Task DecompilingAPluginWhoseSourceHasWorkingTreeChanges_AnswersItRefusedUntilForced()
    {
        await Loaded();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        var sourceFile = Directory.EnumerateFiles(Path.Combine(OtherTool.ModFolderOf(_instance, Origin), "plugin-source"), "*.json", SearchOption.AllDirectories).First();
        File.AppendAllText(sourceFile, " ");

        var refusedBody = await (await Client.Decompile([(Plugin, Origin)])).EnsureSuccessStatusCode().Body();
        var forcedBody = await (await Client.Decompile([(Plugin, Origin)], force: true)).EnsureSuccessStatusCode().Body();

        Assert.Equal("WorkingTreeChanges", Assert.Single(refusedBody.GetProperty("refused").EnumerateArray()).GetProperty("refusal").GetString());
        Assert.Equal([Plugin], forcedBody.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task DecompilingNoPlugin_Is400()
    {
        await Loaded();

        var response = await Client.Decompile([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
