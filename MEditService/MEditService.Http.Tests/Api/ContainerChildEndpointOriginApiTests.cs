using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

// ADR-0012: a load order holding two physical files of one filename, so a route that resolved a
// Quest's children through the wrong plugin shows in the assertion, not just in the row count.
[Collection(WebHostCollection.Name)]
public sealed class ContainerChildEndpointOriginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Both plugins build in the same order from a fresh Fallout4Mod against the same ModKey, so
    // they land on identical FormKeys: one captured FormKey addresses both plugins' children
    // route, distinguished only by `origin`.
    private static string ConfigurePlugin(Fallout4Mod mod, string tag)
    {
        var quest = new Quest(mod) { EditorID = $"Quest{tag}" };
        var topic = new DialogTopic(mod) { EditorID = $"Topic{tag}" };
        var response = new DialogResponses(mod) { EditorID = $"Response{tag}" };
        topic.Responses.Add(response);
        var branch = new DialogBranch(mod) { EditorID = $"Branch{tag}" };
        quest.DialogTopics.Add(topic);
        quest.DialogBranches.Add(branch);
        mod.Quests.Add(quest);
        return quest.FormKey.ToString();
    }

    private static (ScatteredFixtureData Fx, string QuestFk) BuildTwoPlugins()
    {
        string? questFk = null;
        var fx = new PluginFixtureBuilder("api-container-child-origin")
            .WithPlugin("Shared.esp", mod => questFk = ConfigurePlugin(mod, "ModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => ConfigurePlugin(mod, "ModB"), origin: "ModB")
            .BuildScattered();
        return (fx, questFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have captured the quest's FormKey."));
    }

    private async Task PutBothPlugins(ScatteredFixtureData fx)
    {
        // ADR-0013: both plugins travel in the one snapshot, ModB as the overridden plugin at the
        // same slot; only the winning, enabled, listed one participates.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var plugins = fx.Plugins.Select(p => p.Origin == "ModB"
            ? p with { Slot = winner.Slot, Winning = false }
            : p);

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetContainerChildren_ExplicitOrigin_ReturnsThatPluginsOwnChildren_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, questFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(questFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children?origin=ModB");
        var namesB = modB.EnumerateArray().Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId"))).ToArray();
        Assert.Equal(["TopicModB", "BranchModB"], namesB);

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children");
        var namesOmitted = omitted.EnumerateArray().Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId"))).ToArray();
        Assert.Equal(["TopicModA", "BranchModA"], namesOmitted);
    }
}
