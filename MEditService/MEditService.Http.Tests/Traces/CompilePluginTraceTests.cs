using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Http.Tests.TestSupport.Wire;

namespace MEditService.Http.Tests.Traces;

public sealed class CompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Compiled.esp";
    private const string Origin = "CompiledMod";
    private const string OtherPlugin = "AlsoCompiled.esp";
    private const string OtherOrigin = "AlsoCompiledMod";
    private const string NonCompiledPlugin = "NonCompiledPlugin.esp";
    private const string NonCompiledPluginOrigin = "NonSourceMod";

    private static ScatteredFixtureData ThreeMods() =>
        new PluginFixtureBuilder("trace-compile-a-plugin")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("CompiledNpc"), origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("AlsoCompiledNpc"), origin: OtherOrigin)
            .WithPlugin(NonCompiledPlugin, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: NonCompiledPluginOrigin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> LoadedAndCompiledPlugin()
    {
        var fx = ThreeMods();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit([Origin, OtherOrigin])).EnsureSuccessStatusCode();
        return fx;
    }

    [Fact]
    public async Task CompilingAnEditedPlugin_AnswersItApplied_AndItsBytesCarryTheEdit()
    {
        using var fx = await LoadedAndCompiledPlugin();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        var answer = await Answer(await Client.Compile([(Plugin, Origin)]));

        Assert.Empty(answer.GetProperty("refused").EnumerateArray());
        var applied = Assert.Single(answer.GetProperty("applied").EnumerateArray());
        Assert.Equal((Plugin, Origin), (applied.GetProperty("name").GetString(), applied.GetProperty("origin").GetString()));
        Assert.Equal(0.75, await HeightMaxInTheBytesAt(Written(fx, Origin), formKey), 3);
    }

    private static string Written(ScatteredFixtureData fx, string origin) => fx.Plugins.Single(p => p.Origin == origin).Path;

    [Theory]
    [InlineData("[]")]
    [InlineData("[{\"name\": \"Compiled.esp\", \"origin\": \"\"}]")]
    public async Task CompilingNoPlugin_OrAPluginWithoutAnOrigin_Is400(string plugins)
    {
        using var fx = await LoadedAndCompiledPlugin();

        var response = await Client.PostJson("/plugins/compile", $"{{\"plugins\": {plugins}}}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
