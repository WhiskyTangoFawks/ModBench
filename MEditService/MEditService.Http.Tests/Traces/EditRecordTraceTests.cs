using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class EditRecordTraceTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";
    private const string Npc = "EditableNpc";
    private const string OtherPlugin = "Destination.esp";
    private const string OtherOrigin = "DestinationMod";

    private static ScatteredFixtureData TwoMods() =>
        new PluginFixtureBuilder("trace-edit-a-record")
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew(Npc);
                mod.Worldspaces.AddNew("EditableWorld");
            }, origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("DestinationNpc"), origin: OtherOrigin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> Loaded(string compiledOrigin)
    {
        var fx = TwoMods();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(compiledOrigin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        foreach (var plugin in fx.Plugins.Where(p => p.Origin == compiledOrigin)) await Client.PluginReportsCompiledPlugin(plugin.Name);
        return fx;
    }

    private Task<HttpResponseMessage> Edit(string formKey, string member, object value) =>
        Client.Edit(formKey, Plugin, Origin, member, value);

    [Fact]
    public async Task EditingARecord_IsApplied_PushedAsRowsChanged_AndAnsweredByTheNextRead()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        var applied = await Edit(formKey, "HeightMax", 0.75);

        applied.EnsureSuccessStatusCode();
        Assert.NotEmpty((await applied.Body()).GetProperty("documents").EnumerateArray());
        await Client.NextCheck(fx);

        var rows = Assert.Single(await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey)));
        Assert.Equal(Plugin, rows.GetProperty("plugin").GetString());
        Assert.Equal(Origin, rows.GetProperty("origin").GetString());
        Assert.Equal(await Client.Sequence(), rows.GetProperty("sequence").GetInt64());

        var height = (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.75, height.GetProperty("value").GetDouble(), 3);
    }

    [Fact]
    public async Task DeletingARecord_IsApplied_PushedAsRowsChangedNamingIt_AndGoneFromTheNextRead()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        var response = await Client.DeleteRecords([(formKey, Plugin, Origin)]);

        response.EnsureSuccessStatusCode();
        Assert.Single((await response.Body()).GetProperty("applied").EnumerateArray());
        await Client.NextCheck(fx);
        var rows = Assert.Single(await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey)));
        Assert.Equal(Plugin, rows.GetProperty("plugin").GetString());
        Assert.Equal(Origin, rows.GetProperty("origin").GetString());
        Assert.Equal(await Client.Sequence(), rows.GetProperty("sequence").GetInt64());
        Assert.Empty(await NpcFormKeys(Plugin, Origin));
    }

    private async Task<string[]> NpcFormKeys(string plugin, string origin) =>
        [.. (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("formKey").GetString().Require())];

    private static string[] KeysOf(JsonElement rowsChanged) =>
        [.. rowsChanged.GetProperty("keys").EnumerateArray().Select(k => k.GetString().Require())];

    [Fact]
    public async Task CreatingACellInAWorldspace_IsPushedAsRowsChangedNamingItsNewKey_AndReadAtTheGridPositionAsked()
    {
        using var fx = await Loaded(Origin);
        var world = await Client.FirstFormKey(Plugin, Origin, "wrld");
        using var stream = await Client.NotificationStream();

        var created = await Client.CreateRecord(Plugin, Origin, "cell", world, new { x = 1, y = -2 });

        created.EnsureSuccessStatusCode();
        var formKey = (await created.Body()).GetProperty("formKey").GetString().Require();
        await Client.NextCheck(fx);
        var rows = (await stream.EventsUntil("rows-changed", e => KeysOf(e).Contains(formKey)))[^1];
        Assert.Equal((Plugin, Origin), (rows.GetProperty("plugin").GetString(), rows.GetProperty("origin").GetString()));
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/worldspaces/{Uri.EscapeDataString(world)}/blocks?origin={Origin}");
        var cell = blocks.GetProperty("blocks").EnumerateArray()
            .SelectMany(block => block.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(subBlock => subBlock.GetProperty("cells").EnumerateArray())
            .Single(c => c.GetProperty("formKey").GetString() == formKey);
        Assert.Equal((1, -2), (cell.GetProperty("cellX").GetInt32(), cell.GetProperty("cellY").GetInt32()));
    }

    private const string NonCompiledPlugin = "NonCompiledPlugin.esp";
    private const string NonCompiledPluginOrigin = "NonSourceMod";

    [Fact]
    public async Task AnEnvelopeWithAnUnknownOperation_Is400_WithItsOwnRefusal()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        var response = await Client.EditChanges(formKey, Plugin, Origin, "HeightMax", 1, op: "frobnicate");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Body();
        Assert.Equal("InvalidEnvelope", problem.GetProperty("refusal").GetString());
        Assert.Equal("HeightMax", problem.GetProperty("path").GetString());
    }

    [Fact]
    public async Task CopyingTwoRecordsAsOverrides_IntoTwoDestinations_WhereOneIsNonCompiledPlugin_LandsBothInTheCompiledPluginOne_AndAnswersPerItem()
    {
        using var fx = await TwoRecordsAndTwoDestinations();
        var records = await NpcFormKeys(Plugin, Origin);

        var answer = await (await CopyBothIntoBoth(records, "Override")).Body();

        Assert.Equal(
            [(records[0], OtherPlugin), (records[1], OtherPlugin)],
            answer.GetProperty("applied").EnumerateArray().Select(CopiedInto).ToArray());
        Assert.Equal(
            [(records[0], NonCompiledPlugin, "PluginNotCompiledPlugin"), (records[1], NonCompiledPlugin, "PluginNotCompiledPlugin")],
            answer.GetProperty("refused").EnumerateArray().Select(RefusedFrom).ToArray());
        await Client.NextCheck(fx);
        await Waits.ReachedAsync(
            async () => (await NpcFormKeys(OtherPlugin, OtherOrigin)).Intersect(records).Count() == records.Length,
            "the compiled plugin destination to answer both copied records");
        Assert.Empty((await NpcFormKeys(NonCompiledPlugin, NonCompiledPluginOrigin)).Intersect(records));
    }

    private async Task<ScatteredFixtureData> TwoRecordsAndTwoDestinations()
    {
        var fx = new PluginFixtureBuilder("trace-copy-several")
            .WithPlugin(Plugin, mod => { mod.Npcs.AddNew(Npc); mod.Npcs.AddNew("SecondEditableNpc"); }, origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("DestinationNpc"), origin: OtherOrigin)
            .WithPlugin(NonCompiledPlugin, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: NonCompiledPluginOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(OtherOrigin)).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<HttpResponseMessage> CopyBothIntoBoth(string[] records, string mode)
    {
        var response = await Client.Copy(
            [(records[0], Plugin, Origin), (records[1], Plugin, Origin)], mode,
            [(OtherPlugin, OtherOrigin), (NonCompiledPlugin, NonCompiledPluginOrigin)]);
        response.EnsureSuccessStatusCode();
        return response;
    }

    private static (string FormKey, string Destination, string Refusal) RefusedFrom(JsonElement refusal) =>
        (refusal.GetProperty("item").GetProperty("record").GetProperty("formKey").GetString().Require(),
            refusal.GetProperty("item").GetProperty("destination").GetProperty("name").GetString().Require(),
            refusal.GetProperty("refusal").GetString().Require());

    private async Task<double?> HeightMax(string formKey) =>
        (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value") is { ValueKind: JsonValueKind.Number } height ? height.GetDouble() : null;

    private static (string FormKey, string Destination) CopiedInto(JsonElement item) =>
        (item.GetProperty("record").GetProperty("formKey").GetString().Require(),
            item.GetProperty("destination").GetProperty("name").GetString().Require());
}
