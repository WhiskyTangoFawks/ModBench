using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Traces;

/// <summary>edit-record: the envelope goes down to the source tree and the projection comes back
/// up, so the editor sees an applied reply or a typed refusal, then a rows-changed push, then its
/// own re-read.</summary>
[Collection(WebHostCollection.Name)]
public sealed class EditRecordTraceTests : HostedTests
{
    private const string Plugin = "Editable.esp";
    private const string Origin = "EditableMod";
    private const string Npc = "EditableNpc";
    private const string OtherPlugin = "Destination.esp";
    private const string OtherOrigin = "DestinationMod";
    private const int Refused = 422;

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
            (await Client.Track(fx.Plugins.Where(p => p.Origin == origin).Select(p => (p.Name, p.Origin)))).EnsureSuccessStatusCode();
        return fx;
    }

    private Task<HttpResponseMessage> Edit(string formKey, string member, object value) =>
        Client.Edit(formKey, Plugin, Origin, member, value);

    private static async Task<JsonElement> Body(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    // Parse status comes from the codec at edit time (ADR-0015 invariant 5), so a record no door can
    // read is one whose document on disk carries a value of the wrong type.
    private static void MakeTheDocumentUnreadable(string modFolder, string plugin) =>
        OtherTool.EditsASourceDocument(
            modFolder, plugin, "\"EditorID\"", "\"MajorRecordFlagsRaw\": \"notanumber\",\n  \"EditorID\"");

    [Fact]
    public async Task EditingARecord_IsApplied_PushedAsRowsChanged_AndAnsweredByTheNextRead()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();

        var applied = await Edit(formKey, "HeightMax", 0.75);

        applied.EnsureSuccessStatusCode();
        Assert.True((await Body(applied)).GetProperty("applied").GetBoolean());

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
        var formKey = await Client.FirstFormKey(Plugin);
        using var stream = await Client.NotificationStream();

        var response = await Client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey, plugin = Plugin, origin = Origin } },
        });

        response.EnsureSuccessStatusCode();
        Assert.Single((await Body(response)).GetProperty("applied").EnumerateArray());
        var rows = Assert.Single(await stream.EventsUntil(
            "rows-changed", e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey)));
        Assert.Equal(Plugin, rows.GetProperty("plugin").GetString());
        Assert.Equal(Origin, rows.GetProperty("origin").GetString());
        Assert.Equal(await Client.Sequence(), rows.GetProperty("sequence").GetInt64());
        Assert.Empty(await NpcFormKeys(Plugin));
    }

    [Fact]
    public async Task DeletingThreeRecords_WhereOneIsInAnUntrackedPlugin_DeletesTwo_AndAnswersPerRecord()
    {
        using var fx = new PluginFixtureBuilder("trace-delete-three-records")
            .WithPlugin(Plugin, mod => { mod.Npcs.AddNew(Npc); mod.Npcs.AddNew("SecondEditableNpc"); }, origin: Origin)
            .WithPlugin(OtherPlugin, mod => mod.Npcs.AddNew("DestinationNpc"), origin: OtherOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        var tracked = await NpcFormKeys(Plugin);
        var untracked = await Client.FirstFormKey(OtherPlugin);
        var before = await Client.Sequence();

        var response = await Client.PostAsJsonAsync("/records/delete", new
        {
            records = new[]
            {
                new { formKey = tracked[0], plugin = Plugin, origin = Origin },
                new { formKey = untracked, plugin = OtherPlugin, origin = OtherOrigin },
                new { formKey = tracked[1], plugin = Plugin, origin = Origin },
            },
        });

        response.EnsureSuccessStatusCode();
        var answer = await Body(response);
        Assert.Equal(
            [(tracked[0], Plugin, Origin), (tracked[1], Plugin, Origin)],
            answer.GetProperty("applied").EnumerateArray().Select(Addressed).ToArray());
        var refused = Assert.Single(answer.GetProperty("refused").EnumerateArray().ToArray());
        Assert.Equal((untracked, OtherPlugin, OtherOrigin), Addressed(refused.GetProperty("record")));
        Assert.Equal("PluginNotTracked", refused.GetProperty("refusal").GetString());
        Assert.Contains("Track", refused.GetProperty("message").GetString().Require(), StringComparison.Ordinal);

        await Client.SequenceReaches(before + 1);
        var remaining = await NpcFormKeys(Plugin);
        var untouched = await NpcFormKeys(OtherPlugin);
        Assert.Empty(remaining);
        Assert.Equal([untracked], untouched);
    }

    private async Task<string[]> NpcFormKeys(string plugin) =>
        [.. (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&type=npc_"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("formKey").GetString().Require())];

    private static (string FormKey, string Plugin, string Origin) Addressed(JsonElement record) => (
        record.GetProperty("formKey").GetString().Require(),
        record.GetProperty("plugin").GetString().Require(),
        record.GetProperty("origin").GetString().Require());

    // A race that morphs into itself links itself, and the NPCs of three plugins link it: its own,
    // a tracked one and an untracked one.
    private static ScatteredFixtureData ARaceAndItsReferencers() =>
        new PluginFixtureBuilder("trace-formid-target-only")
            .WithPlugin(Plugin, mod =>
            {
                var race = mod.Races.AddNew("MovedRace");
                race.MorphRace.SetTo(race);
                mod.Npcs.AddNew("SamePluginNpc").Race.SetTo(race);
            }, origin: Origin)
            .WithPlugin(OtherPlugin, (mod, earlier) =>
                mod.Npcs.AddNew("TrackedReferencerNpc").Race.SetTo(earlier[0].Races.First()), origin: OtherOrigin)
            .WithPlugin(UntrackedPlugin, (mod, earlier) =>
                mod.Npcs.AddNew("UntrackedReferencerNpc").Race.SetTo(earlier[0].Races.First()), origin: UntrackedOrigin)
            .BuildScattered();

    private const string UntrackedPlugin = "Untracked.esp";
    private const string UntrackedOrigin = "UntrackedMod";

    [Fact]
    public async Task EditingTheFormId_ChangesOnlyItsFormKey_LeavesEveryReferencerAsItWas_AndIsReadAgainUnderTheNewOne()
    {
        using var fx = ARaceAndItsReferencers();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        (await Client.Track(OtherPlugin, OtherOrigin)).EnsureSuccessStatusCode();
        var targetFolder = OtherTool.ModFolderOf(fx, Origin);
        var target = new PluginCopyKey(Plugin, Origin);
        var oldFormKey = (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=race"))
            .GetProperty("items").EnumerateArray().Select(i => DocumentNodes.StringValueOf(i.GetProperty("formKey"))).Single();
        var targetBefore = TrackedTree.Document(targetFolder, target, oldFormKey).Require();
        var samePluginReferencer = OtherTool.SourceDocumentCarrying(targetFolder, Plugin, "SamePluginNpc");
        var samePluginBefore = File.ReadAllText(samePluginReferencer);
        var trackedBefore = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OtherOrigin));
        var untrackedBefore = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UntrackedOrigin));
        var newFormKey = $"000F00:{Plugin}";
        using var stream = await Client.NotificationStream();

        var response = await Edit(oldFormKey, "FormKey", newFormKey);

        response.EnsureSuccessStatusCode();
        Assert.Equal(newFormKey, DocumentNodes.StringValueOf((await Body(response)).GetProperty("newFormKey")));
        Assert.Null(TrackedTree.Document(targetFolder, target, oldFormKey));
        var targetAfter = TrackedTree.Document(targetFolder, target, newFormKey).Require();
        var formKeyLine = $"\"FormKey\": \"{oldFormKey}\"";
        Assert.Contains(formKeyLine, targetBefore.Body, StringComparison.Ordinal);
        Assert.Equal(
            targetBefore.Body.Replace(formKeyLine, $"\"FormKey\": \"{newFormKey}\"", StringComparison.Ordinal),
            targetAfter.Body);
        Assert.Equal(samePluginBefore, File.ReadAllText(samePluginReferencer));
        Assert.Equal(trackedBefore, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OtherOrigin)));
        Assert.Equal(untrackedBefore, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UntrackedOrigin)));
        // A document the Index never saw moves which records the plugin has, so the plugin is read
        // again whole and named, not its rows.
        var changed = Assert.Single(await stream.EventsUntil(
            "plugin-changed", e => e.GetProperty("plugin").GetString() == Plugin));
        Assert.Equal(Origin, changed.GetProperty("origin").GetString());
        Assert.Equal("MovedRace", (await Client.Record(newFormKey)).GetProperty("editorId").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await Client.GetAsync($"/records/{Uri.EscapeDataString(oldFormKey)}")).StatusCode);
    }

    [Fact]
    public async Task EditingAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = await Loaded();

        var response = await Edit(await Client.FirstFormKey(Plugin), "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
        Assert.Contains("Track", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnEnvelopeWithAnUnknownOperation_Is400_WithItsOwnRefusal()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin);

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new
            {
                plugin = Plugin,
                origin = Origin,
                op = "frobnicate",
                path = new[] { new { kind = "member", name = "HeightMax" } },
                value = 1,
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("InvalidEnvelope", problem.GetProperty("refusal").GetString());
        Assert.Equal("HeightMax", problem.GetProperty("path").GetString());
    }

    [Fact]
    public async Task AnEnvelopeNamingAFieldTheRecordHasNot_Is404_WithItsOwnRefusal()
    {
        using var fx = await Loaded(Origin);

        var response = await Edit(await Client.FirstFormKey(Plugin), "no_such_field", 1);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("FieldNotFound", (await Body(response)).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AnEnvelopeWithoutAPlugin_Is400()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin);

        var response = await Client.Edit(formKey, string.Empty, Origin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Something outside Modbench replaced this record's document with a directory. The tree is the
    // only thing asked, so a document that cannot be read is a record the plugin does not hold.
    [Fact]
    public async Task EditingARecordWhoseDocumentIsNoLongerAFile_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = await Loaded(Origin);
        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, Origin), Plugin, Npc);
        File.Delete(document);
        Directory.CreateDirectory(document);

        var response = await Edit(await Client.FirstFormKey(Plugin), "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.False(string.IsNullOrWhiteSpace((await Body(response)).GetProperty("detail").GetString()));
    }

    [Fact]
    public async Task EditingARecordTheCodecCannotRead_IsRefusedAsAParseFailure()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin);
        MakeTheDocumentUnreadable(OtherTool.ModFolderOf(fx, Origin), Plugin);

        var response = await Edit(formKey, "HeightMax", 0.75);

        await AssertParseRefusal(response);
    }

    [Fact]
    public async Task CopyingARecordTheCodecCannotRead_AsAnOverride_IsTheSameRefusal()
    {
        using var fx = await Loaded(Origin, OtherOrigin);
        var formKey = await Client.FirstFormKey(Plugin);
        MakeTheDocumentUnreadable(OtherTool.ModFolderOf(fx, Origin), Plugin);

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-override",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = OtherPlugin,
                destinationOrigin = OtherOrigin,
            });

        await AssertParseRefusal(response);
    }

    [Fact]
    public async Task CopyingARecordAsNew_LandsUnderADerivedEditorID_DifferentFromTheSources()
    {
        using var fx = await Loaded(Origin, OtherOrigin);
        var formKey = await Client.FirstFormKey(Plugin);

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = OtherPlugin,
                destinationOrigin = OtherOrigin,
                requestedFormKey = (string?)null,
            });

        response.EnsureSuccessStatusCode();
        var newFormKey = (await Body(response)).GetProperty("newFormKey").GetString().Require();
        Assert.NotEqual(formKey, newFormKey);

        var document = OtherTool.SourceDocumentCarrying(OtherTool.ModFolderOf(fx, OtherOrigin), OtherPlugin, newFormKey);
        var text = File.ReadAllText(document);
        Assert.Contains($"\"EditorID\": \"{Npc}DUPLICATE001\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain($"\"EditorID\": \"{Npc}\"", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CopyingARecordTheCodecCannotRead_AsANewRecord_IsTheSameRefusal()
    {
        using var fx = await Loaded(Origin, OtherOrigin);
        var formKey = await Client.FirstFormKey(Plugin);
        MakeTheDocumentUnreadable(OtherTool.ModFolderOf(fx, Origin), Plugin);

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = OtherPlugin,
                destinationOrigin = OtherOrigin,
                requestedFormKey = (string?)null,
            });

        await AssertParseRefusal(response);
    }

    private static async Task AssertParseRefusal(HttpResponseMessage response)
    {
        Assert.Equal(Refused, (int)response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("RecordParseFailed", problem.GetProperty("refusal").GetString());
        Assert.Contains("Unable to cast", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
    }

    // FormKey.Factory throws on malformed input, and the fix is the endpoint's own 400 rather than a
    // new refusal case: both doors that take a typed FormKey as an Option answer the same.
    [Fact]
    public async Task CreatingARecordWithAMalformedFormKey_Is400()
    {
        using var fx = await Loaded(Origin);

        var response = await Client.PostAsJsonAsync(
            $"/plugins/{Plugin}/records",
            new { origin = Origin, recordType = "npc_", editorId = "Broken", formKey = "not-a-formkey" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // A FormID is a field value, so one that is no FormKey is refused as the codec's rejection.
    [Fact]
    public async Task EditingTheFormIdToAMalformedFormKey_IsRefusedAsTheCodecsRejection_NamingTheField()
    {
        using var fx = await Loaded(Origin);
        var formKey = await Client.FirstFormKey(Plugin);

        var response = await Edit(formKey, "FormKey", "not-a-formkey");

        Assert.Equal(Refused, (int)response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("CodecRejected", problem.GetProperty("refusal").GetString());
        Assert.Equal("FormKey", problem.GetProperty("path").GetString());
    }

    [Fact]
    public async Task CopyingARecordToAMalformedFormKey_Is400()
    {
        using var fx = await Loaded(Origin, OtherOrigin);
        var formKey = await Client.FirstFormKey(Plugin);

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/copy-as-new-record",
            new
            {
                sourcePlugin = Plugin,
                sourceOrigin = Origin,
                destinationPlugin = OtherPlugin,
                destinationOrigin = OtherOrigin,
                requestedFormKey = "not-a-formkey",
            });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Asserted against the served document because that is what the frontend client is generated
    // from, so absent here is what makes the verb uncallable.
    [Fact]
    public async Task TheServedApi_OffersNoMutatingVerbOnTheRecordRoute()
    {
        var document = JsonDocument.Parse(await Client.GetStringAsync("/swagger/v1/swagger.json"));
        var verbs = document.RootElement.GetProperty("paths").GetProperty("/records/{formKey}")
            .EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("get", verbs);
        Assert.Equal([], verbs.Where(verb => verb is "patch" or "post" or "put" or "delete").ToArray());
    }
}
