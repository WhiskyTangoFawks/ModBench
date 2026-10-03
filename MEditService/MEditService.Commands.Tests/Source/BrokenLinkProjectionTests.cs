using System.Text.Json;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Source;

public sealed class BrokenLinkProjectionTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void AnEditPointingALinkAtAFormKeyNoPluginProvides_Lands()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.Set(
            mod.Plugin, mod.Npc.ToString(), "Keywords", Json("[\"ABCDEF:NoSuchPlugin.esp\"]"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void AnEditPointingALinkAtTheWrongRecordType_Lands()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "Keywords", Json($"[\"{mod.Race}\"]"));

        Assert.True(result.Applied, result.Message);
    }
}
