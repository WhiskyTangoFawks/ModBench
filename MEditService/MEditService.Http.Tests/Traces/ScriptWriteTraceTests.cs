using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class ScriptWriteTraceTests : HostedTests
{
    private const string Plugin = "Scripted.esp";
    private const string Origin = "ScriptedMod";

    [Fact]
    public async Task AQueryAfterAScriptsWrite_AnswersTheWrittenRow()
    {
        var fx = Owned(new PluginFixtureBuilder("trace-script-write")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ScriptedNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Init(Origin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Client.ScriptEdit(formKey, Plugin, Origin, "EditorID", "WrittenNpc")).EnsureSuccessStatusCode();

        var response = await Client.PostAsJsonAsync("/records/select", new { sql = $"SELECT editor_id FROM records WHERE form_key = '{formKey}'" });

        var rows = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("rows");
        Assert.Equal("WrittenNpc", Assert.Single(rows.EnumerateArray()).GetProperty("editor_id").GetString());
    }
}
