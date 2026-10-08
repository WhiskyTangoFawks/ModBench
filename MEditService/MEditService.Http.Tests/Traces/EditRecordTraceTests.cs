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
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("DestinationNpc"), origin: OtherOrigin)
            .BuildScattered();

    private async Task<ScatteredFixtureData> Loaded(params string[] tracked)
    {
        var fx = TwoMods();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        foreach (var origin in tracked)
            (await Client.Track(origin)).EnsureSuccessStatusCode();
        if (tracked.Length == 0) return fx;

        await Client.NextSnapshot(fx);
        foreach (var plugin in fx.Plugins.Where(p => tracked.Contains(p.Origin))) await Client.PluginReportsTracked(plugin.Name);
        return fx;
    }

    private Task<HttpResponseMessage> Edit(string formKey, string member, object value) =>
        Client.Edit(formKey, Plugin, Origin, member, value);

    private static async Task<JsonElement> Body(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    [Fact]
    public async Task EditingARecord_IsApplied_PushedAsRowsChanged_AndAnsweredByTheNextRead()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        var applied = await Edit(formKey, "HeightMax", 0.75);

        applied.EnsureSuccessStatusCode();
        Assert.NotEmpty((await Body(applied)).GetProperty("documents").EnumerateArray());
        await Client.NextSnapshot(fx);

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
    public async Task AnEditedRecord_IsListedAsModified()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        (await Edit(formKey, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);

        await Wire.Eventually(async () =>
            (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_"))
                .GetProperty("items")[0].GetProperty("workingTreeState").GetString() == "Modified",
            "the edited record listed as Modified");
    }

    [Fact]
    public async Task DeletingARecord_IsApplied_PushedAsRowsChangedNamingIt_AndGoneFromTheNextRead()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        using var stream = await Client.NotificationStream();

        var response = await Client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey, plugin = Plugin, origin = Origin } },
        });

        response.EnsureSuccessStatusCode();
        Assert.Single((await Body(response)).GetProperty("applied").EnumerateArray());
        await Client.NextSnapshot(fx);
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
    public async Task CreatingARecord_IsPushedAsRowsChangedNamingItsNewKey_AndAnsweredByTheNextRead()
    {
        using var fx = await Loaded(Origin);
        using var stream = await Client.NotificationStream();

        var created = await Client.PostAsJsonAsync(
            $"/plugins/{Plugin}/records", new { origin = Origin, recordType = "npc_" });

        created.EnsureSuccessStatusCode();
        var formKey = (await Body(created)).GetProperty("formKey").GetString().Require();
        await Client.NextSnapshot(fx);
        var rows = (await stream.EventsUntil("rows-changed", e => KeysOf(e).Contains(formKey)))[^1];
        Assert.Equal(Plugin, rows.GetProperty("plugin").GetString());
        Assert.Equal(Origin, rows.GetProperty("origin").GetString());
        Assert.Equal(formKey, (await Client.Record(formKey)).GetProperty("formKey").GetString());
    }

    private const string UntrackedPlugin = "Untracked.esp";
    private const string UntrackedOrigin = "UntrackedMod";

    [Fact]
    public async Task EditingAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = await Loaded();

        var response = await Edit(await Client.FirstFormKey(Plugin, Origin), "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
        Assert.Contains("Track", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithAnUnknownOperation_Is400_WithItsOwnRefusal()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        var response = await Client.EditChanges(
            formKey, Plugin, Origin, "HeightMax", 1, await Client.CopyDocumentText(formKey, Plugin, Origin), op: "frobnicate");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("InvalidEnvelope", problem.GetProperty("refusal").GetString());
        Assert.Equal("HeightMax", problem.GetProperty("path").GetString());
    }

    [Fact]
    public async Task AnEnvelopeNamingAFieldTheRecordHasNot_Is404_WithItsOwnRefusal()
    {
        using var fx = await Loaded(Origin);

        var response = await Edit(await Client.FirstFormKey(Plugin, Origin), "no_such_field", 1);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("FieldNotFound", (await Body(response)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEnvelopeWithoutAPlugin_Is400()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);

        var response = await Client.Edit(formKey, string.Empty, Origin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CopyingTwoRecordsAsOverrides_IntoTwoDestinations_WhereOneIsUntracked_LandsBothInTheTrackedOne_AndAnswersPerItem()
    {
        using var fx = await TwoRecordsAndTwoDestinations();
        var records = await NpcFormKeys(Plugin, Origin);

        var answer = await Body(await CopyBothIntoBoth(records, "Override"));

        Assert.Equal(
            [(records[0], OtherPlugin), (records[1], OtherPlugin)],
            answer.GetProperty("applied").EnumerateArray().Select(CopiedInto).ToArray());
        Assert.Equal(
            [(records[0], UntrackedPlugin, "PluginNotTracked"), (records[1], UntrackedPlugin, "PluginNotTracked")],
            answer.GetProperty("refused").EnumerateArray().Select(RefusedFrom).ToArray());
        await Client.NextSnapshot(fx);
        await Wire.Eventually(
            async () => (await NpcFormKeys(OtherPlugin, OtherOrigin)).Intersect(records).Count() == records.Length,
            "the tracked destination to answer both copied records");
        Assert.Empty((await NpcFormKeys(UntrackedPlugin, UntrackedOrigin)).Intersect(records));
    }

    private async Task<ScatteredFixtureData> TwoRecordsAndTwoDestinations()
    {
        var fx = new PluginFixtureBuilder("trace-copy-several")
            .WithPlugin(Plugin, mod => { mod.Npcs.AddNew(Npc); mod.Npcs.AddNew("SecondEditableNpc"); }, origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("DestinationNpc"), origin: OtherOrigin)
            .WithPlugin(UntrackedPlugin, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: UntrackedOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(OtherOrigin)).EnsureSuccessStatusCode();
        return fx;
    }

    private async Task<HttpResponseMessage> CopyBothIntoBoth(string[] records, string mode)
    {
        var response = await Client.Copy(
            [(records[0], Plugin, Origin), (records[1], Plugin, Origin)], mode,
            [(OtherPlugin, OtherOrigin), (UntrackedPlugin, UntrackedOrigin)]);
        response.EnsureSuccessStatusCode();
        return response;
    }

    private static (string FormKey, string Destination, string Refusal) RefusedFrom(JsonElement refusal) =>
        (refusal.GetProperty("item").GetProperty("record").GetProperty("formKey").GetString().Require(),
            refusal.GetProperty("item").GetProperty("destination").GetProperty("name").GetString().Require(),
            refusal.GetProperty("refusal").GetString().Require());

    [Fact]
    public async Task CopyingAsOverride_IntoADestinationThatHoldsTheRecord_ReplacesIt_WithTheReplaceOption()
    {
        using var fx = await Loaded(OtherOrigin);
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        var copiedHeight = await HeightMax(formKey);
        (await Client.Copy(formKey, (Plugin, Origin), "Override", (OtherPlugin, OtherOrigin))).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => (await NpcFormKeys(OtherPlugin, OtherOrigin)).Contains(formKey), "the copy to be answered");
        (await Client.Edit(formKey, OtherPlugin, OtherOrigin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => await HeightMax(formKey) == 0.75, "the edit of the copy to be answered");

        var response = await Client.Copy(formKey, (Plugin, Origin), "Override", (OtherPlugin, OtherOrigin), replace: true);

        response.EnsureSuccessStatusCode();
        Assert.Single((await Body(response)).GetProperty("applied").EnumerateArray());
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => await HeightMax(formKey) == copiedHeight, "the replacement to be answered");
    }

    private async Task<double?> HeightMax(string formKey) =>
        (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value") is { ValueKind: JsonValueKind.Number } height ? height.GetDouble() : null;

    private static (string FormKey, string Destination) CopiedInto(JsonElement item) =>
        (item.GetProperty("record").GetProperty("formKey").GetString().Require(),
            item.GetProperty("destination").GetProperty("name").GetString().Require());
}
