using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class ChildRecordQueryApiTests : HostedTests
{
    private const string Source = "Source.esp";
    private const string SourceMod = "SourceMod";
    private const string WithTopic = "WithTopic.esp";
    private const string WithTopicMod = "WithTopicMod";
    private const string ParentOnly = "ParentOnly.esp";
    private const string ParentOnlyMod = "ParentOnlyMod";

    private async Task<(ScatteredFixtureData Fx, string Quest, string Npc)> Loaded()
    {
        string quest = "", npc = "";
        var fx = Owned(new PluginFixtureBuilder("child-record-queries")
            .WithPlugin(Source, mod =>
            {
                var q = mod.Quests.AddNew("Quest");
                var t = new DialogTopic(mod) { EditorID = "Topic" };
                q.DialogTopics.Add(t);
                (quest, npc) = (q.FormKey.ToString(), mod.Npcs.AddNew("Npc").FormKey.ToString());
            }, origin: SourceMod)
            .WithPlugin(WithTopic, (mod, built) => mod.Quests.GetOrAddAsOverride(built[0].Quests.Single()), origin: WithTopicMod)
            .WithPlugin(
                ParentOnly,
                (mod, built) => mod.Quests.GetOrAddAsOverride(built[0].Quests.Single()).DialogTopics.Clear(),
                origin: ParentOnlyMod)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return (fx, quest, npc);
    }

    private static object Record(string formKey, string plugin = Source, string origin = SourceMod) =>
        new { formKey, plugin, origin };

    private static object Destination(string name, string origin) => new { name, origin };

    [Fact]
    public async Task TheRecordsWithChildRecords_AreThoseOfTheSelectionThatHoldAny()
    {
        var (_, quest, npc) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/with-children", new { records = new[] { Record(npc), Record(quest) } });

        response.EnsureSuccessStatusCode();
        var answer = await response.Content.ReadFromJsonAsync<JsonElement>();
        var only = Assert.Single(answer.EnumerateArray());
        Assert.Equal(quest, only.GetProperty("formKey").GetString());
        Assert.Equal(Source, only.GetProperty("plugin").GetString());
        Assert.Equal(SourceMod, only.GetProperty("origin").GetString());
    }

    [Fact]
    public async Task TheDestinationsHoldingARecordsChildRecords_AreAnsweredPerRecord()
    {
        var (_, quest, npc) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/children-in-destinations", new
        {
            records = new[] { Record(quest), Record(npc) },
            destinations = new[] { Destination(WithTopic, WithTopicMod), Destination(ParentOnly, ParentOnlyMod) },
        });

        response.EnsureSuccessStatusCode();
        var answer = (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToList();
        Assert.Equal([quest, npc], answer.Select(a => a.GetProperty("record").GetProperty("formKey").GetString()));
        var holding = Assert.Single(answer[0].GetProperty("destinations").EnumerateArray());
        Assert.Equal(WithTopic, holding.GetProperty("name").GetString());
        Assert.Equal(WithTopicMod, holding.GetProperty("origin").GetString());
        Assert.Empty(answer[1].GetProperty("destinations").EnumerateArray());
    }

    [Theory]
    [InlineData("/records/with-children")]
    [InlineData("/records/children-in-destinations")]
    public async Task AQueryOverNoRecords_Is400(string route)
    {
        var response = await Client.PostAsJsonAsync(route, new { records = Array.Empty<object>(), destinations = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task AQueryNamingADestinationWithNoOrigin_Is400()
    {
        var response = await Client.PostAsJsonAsync("/records/children-in-destinations", new
        {
            records = new[] { Record("000800:Source.esp") },
            destinations = new[] { Destination(WithTopic, "") },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task AQueryWithARecordMissingItsOrigin_Is400()
    {
        var response = await Client.PostAsJsonAsync("/records/with-children", new { records = new[] { Record("000800:Source.esp", origin: "") } });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("/records/with-children")]
    [InlineData("/records/children-in-destinations")]
    public async Task AQueryWithNoLoadOrder_Is503(string route)
    {
        var response = await Client.PostAsJsonAsync(route, new { records = new[] { Record("000800:Source.esp") } });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }
}
