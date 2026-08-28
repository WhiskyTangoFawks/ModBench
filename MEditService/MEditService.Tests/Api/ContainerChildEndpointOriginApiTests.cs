using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

// #424 / #305 / ADR-0036: the wire-level guard rail for GetContainerChildren, mirroring
// SpatialRoutesOriginApiTests' real two-copy load path — a session that actually holds two
// physical files of one filename, so a route that resolved a Quest's children session-wide (or
// through the wrong copy) is visible in the assertion, not just in the row count.
public sealed class ContainerChildEndpointOriginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Each copy gets its own Quest with one DialogTopic (holding one Response) and one
    // DialogBranch, all EditorID-tagged with the origin that built them. Both copies construct
    // their content in the same order from a fresh Fallout4Mod against the same ModKey, so they
    // land on identical FormKeys — same trick SpatialRoutesOriginApiTests' shared-FormKey pair
    // uses — which is what lets one captured FormKey address both copies' children route,
    // distinguished only by the `origin` query param under test.
    private static string ConfigureCopy(Fallout4Mod mod, string tag)
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

    private static (ScatteredFixtureData Fx, string QuestFk) BuildTwoCopies()
    {
        string? questFk = null;
        var fx = new PluginFixtureBuilder("api-container-child-origin")
            .WithPlugin("Shared.esp", mod => questFk = ConfigureCopy(mod, "ModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => ConfigureCopy(mod, "ModB"), origin: "ModB")
            .BuildScattered();
        return (fx, questFk!);
    }

    // Same real load path as SpatialRoutesOriginApiTests: the load order names exactly one
    // Shared.esp (ModA), and ModB arrives afterwards, on demand, as the copy the load order does
    // not name.
    private async Task LoadWinningCopyThenShadowedCopy(ScatteredFixtureData fx)
    {
        var shadowed = fx.Plugins.Single(p => p.Origin == "ModB");
        var loadOrder = fx.Plugins.Where(p => p.Origin != "ModB");

        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = loadOrder.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var onDemand = await _client.PostAsJsonAsync("/plugins/load", new { path = shadowed.Path, origin = shadowed.Origin });
        onDemand.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetContainerChildren_ExplicitOrigin_ReturnsThatCopysOwnChildren_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, questFk) = BuildTwoCopies();
        using var _fx = fx;
        await LoadWinningCopyThenShadowedCopy(fx);
        var encodedFk = Uri.EscapeDataString(questFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children?origin=ModB");
        var namesB = modB.EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray();
        Assert.Equal(["TopicModB", "BranchModB"], namesB);

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children");
        var namesOmitted = omitted.EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray();
        Assert.Equal(["TopicModA", "BranchModA"], namesOmitted);
    }
}
