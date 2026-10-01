using System.Net;
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
            .WithPlugin("Shared.esp", mod => ConfigurePlugin(mod, "ModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod => questFk = ConfigurePlugin(mod, "ModA"), origin: "ModA")
            .BuildScattered();
        return (fx, questFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have captured the quest's FormKey."));
    }

    private async Task PutBothPlugins(ScatteredFixtureData fx, string winner = "ModA")
    {
        // ADR-0013: both plugins travel in the one snapshot, the overridden one at the same slot;
        // only the winning, enabled, listed one is active, and only it is read.
        var plugins = fx.Plugins.Select(p => p.Name == "Shared.esp" ? p with { Winning = p.Origin == winner } : p).ToList();

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(plugins),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetContainerChildren_ExplicitOrigin_ReturnsThatPluginsOwnChildren()
    {
        var (fx, questFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx, winner: "ModB");
        var encodedFk = Uri.EscapeDataString(questFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children?origin=ModB");
        var namesB = modB.EnumerateArray().Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId"))).ToArray();
        Assert.Equal(["TopicModB", "BranchModB"], namesB);
        var modA = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children?origin=ModA");
        Assert.Empty(modA.EnumerateArray());
    }

    // ADR-0012 invariant 1: a plugin filter with no origin would match every plugin sharing that
    // filename, so the route refuses rather than picking the load order's winner for it.
    [Fact]
    public async Task GetContainerChildren_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, questFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(questFk);

        var omitted = await _client.GetAsync($"/plugins/Shared.esp/records/{encodedFk}/children");
        Assert.Equal(HttpStatusCode.BadRequest, omitted.StatusCode);
        Assert.Equal("application/problem+json", omitted.Content.Headers.ContentType?.MediaType);
        var body = await omitted.Body();
        Assert.Equal("Origin is required.", body.GetProperty("detail").GetString());
    }
}
