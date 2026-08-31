using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

// ADR-0036: the wire-level guard rail for GetContainerChildren, mirroring
// SpatialRoutesOriginApiTests' real two-copy load path — a load order that actually holds two
// physical files of one filename, so a route that resolved a Quest's children load-order-wide (or
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

    private async Task PutBothCopies(ScatteredFixtureData fx)
    {
        // ADR-0044: both copies travel in the one snapshot — ModA as the copy the Mod override
        // order resolves the name to, ModB as the losing copy at the same slot — and both are
        // registered; only the winning, enabled, listed one ever participates.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var plugins = fx.Plugins.Select(p => p.Origin == "ModB"
            ? p with { Slot = winner.Slot, Winning = false }
            : p);

        var put = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetContainerChildren_ExplicitOrigin_ReturnsThatCopysOwnChildren_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, questFk) = BuildTwoCopies();
        using var _fx = fx;
        await PutBothCopies(fx);
        var encodedFk = Uri.EscapeDataString(questFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children?origin=ModB");
        var namesB = modB.EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray();
        Assert.Equal(["TopicModB", "BranchModB"], namesB);

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/records/{encodedFk}/children");
        var namesOmitted = omitted.EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray();
        Assert.Equal(["TopicModA", "BranchModA"], namesOmitted);
    }
}
