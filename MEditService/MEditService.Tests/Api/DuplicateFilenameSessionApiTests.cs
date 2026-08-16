using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

// #34 / ADR-0036: the end-to-end guard rail the identity migration (#271/#272/#275/#296) never
// had. Every one of those tickets proved its own seam against a hand-constructed pair built
// *below* GameSession — `repo.Index(mod, origin: "ModA")` at the repository seam, fake sessions,
// webview fixtures — because no session could hold two same-filename plugins to build a real pair
// from. This test is the one that goes through the real load path: two physical copies of one
// filename, in two mod folders, loaded together and read back over the wire.
//
// It is deliberately the first thing this ticket does, because three of the five live bugs the
// migration found were at the *joins* between phases rather than inside them — exactly what a
// seam-local test cannot see. It also removes ColumnKey.Of's blind spot by construction: that
// method elides the reserved DataDirectory origin, so any fixture using the default origin passes
// whether or not the code is correct, and both copies here carry real mod-folder origins.
public sealed class DuplicateFilenameSessionApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Both copies answer to one filename and are distinguishable only by content: each carries a
    // single NPC whose EditorID names the mod folder it came from. Both NPCs land on the same
    // FormKey (each copy runs its own NextFormID sequence from the same ModKey), which is what
    // makes this the delta-comparison case the ticket is named for rather than two unrelated files.
    private static ScatteredFixtureData BuildTwoCopies() =>
        new PluginFixtureBuilder("api-duplicate-filename")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            // An ordinary editable plugin mastering Shared.esp, so a copy-as-override out of
            // either column has somewhere legitimate to land.
            .WithPlugin("Target.esp", (mod, _) =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Shared.esp") }),
                origin: "TargetMod")
            .BuildScattered();

    /// <summary>
    /// The real load path, in the order production uses it: the load order names exactly one
    /// Shared.esp — MO2's file-conflict merge already picked a winner, so plugins.txt can never
    /// name both — and the copy it shadows arrives afterwards, on demand.
    /// </summary>
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
    public async Task ShadowedCopyLoadedOnDemand_IsASessionPluginAlongsideTheCopyThatShadowsIt()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var copies = plugins.EnumerateArray()
            .Where(p => p.GetProperty("name").GetString() == "Shared.esp")
            .Select(p => p.GetProperty("origin").GetString())
            .ToList();

        Assert.Equal(["ModA", "ModB"], copies);
    }

    [Fact]
    public async Task ShadowedCopyLoadedOnDemand_IndexesItsOwnRecordsNotTheOtherCopys()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        // Deliberately unfiltered by plugin: `?plugin=` resolves origin from the filename
        // server-side (PluginOriginResolver, #296), so it can only ever answer for one of two
        // same-filename copies. Giving that route an explicit origin is its own slice; what this
        // one proves is that the *index* holds each copy's own content.
        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        var byOrigin = records.GetProperty("items").EnumerateArray()
            .Where(r => r.GetProperty("plugin").GetString() == "Shared.esp")
            .ToDictionary(r => r.GetProperty("origin").GetString()!, r => r.GetProperty("editorId").GetString());

        // Both NPCs share a FormKey and differ only in content, so a session that keyed its opened
        // mods by filename alone reports two rows with the right origins and the *same* content —
        // the failure this pins down is not a missing row.
        Assert.Equal("FromModA", byOrigin["ModA"]);
        Assert.Equal("FromModB", byOrigin["ModB"]);
    }

    [Fact]
    public async Task BrowsingByOrigin_ReturnsThatCopysOwnRecordsAndCounts()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        // The tree row knows which copy it stands for, so it says so rather than leaving the server
        // to guess from the filename — which is the one thing a filename can no longer answer.
        var records = await _client.GetFromJsonAsync<JsonElement>("/records?plugin=Shared.esp&origin=ModB&type=npc_&limit=10");
        var editorIds = records.GetProperty("items").EnumerateArray()
            .Select(r => r.GetProperty("editorId").GetString())
            .ToList();
        Assert.Equal(["FromModB"], editorIds);

        var types = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/record-types?origin=ModB");
        Assert.Equal(1, types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "npc_").GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task ShadowedCopyLoadedOnDemand_IsItsOwnCompareColumn()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        var columns = compare.GetProperty("overrides").EnumerateArray()
            .ToDictionary(o => o.GetProperty("origin").GetString()!, o => o);

        // The two copies are one column each, carrying their own record — this is the delta
        // comparison the ticket exists for. GetCompare builds its masters and participation
        // lookups keyed by bare filename, so a second copy of one filename makes them ambiguous
        // (in fact a duplicate-key throw) rather than merely mis-keyed.
        Assert.Equal("FromModA", columns["ModA"].GetProperty("editorId").GetString());
        Assert.Equal("FromModB", columns["ModB"].GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task ShadowedCopyLoadedOnDemand_NeverWinsAndDoesNotConflictWithTheCopyThatShadowsIt()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        var columns = compare.GetProperty("overrides").EnumerateArray()
            .ToDictionary(o => o.GetProperty("origin").GetString()!, o => o);

        // #267's participation predicate is what makes lazy loading safe (ADR-0035): a copy the
        // game does not load can never take the winner, and two copies differing in EditorID must
        // not read as a conflict between them.
        Assert.True(columns["ModA"].GetProperty("isWinner").GetBoolean());
        Assert.False(columns["ModB"].GetProperty("isWinner").GetBoolean());
        // OnlyOne, not NoConflict: classification sees a single participating copy, so this record
        // is exactly as unconflicted as it was before the shadowed copy was loaded — which is the
        // whole claim, that loading one changes no classification already on screen.
        Assert.Equal("OnlyOne", compare.GetProperty("conflictAll").GetString());
    }

    [Fact]
    public async Task CopyAsOverrideFromTheShadowedColumn_CopiesThatColumnsContent()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        // Reading a shadowed copy is not editing it (ADR-0036), so copy-as-override *out* of its
        // column is allowed — and must take that column's record, not whichever copy a filename
        // happens to resolve to. This is the write-path half of "every action invoked on one
        // copy's column affects only that copy".
        var copy = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/copy-to/{Uri.EscapeDataString("Target.esp")}",
            new { source = "user", sourcePlugin = "Shared.esp", sourceOrigin = "ModB" });
        copy.EnsureSuccessStatusCode();

        var staged = await copy.Content.ReadFromJsonAsync<JsonElement>();
        // EditorID is a column of its own, not a reflected field, so it never appears among staged
        // changes — the copies carry a distinguishing NPC Name for exactly this assertion.
        var name = staged.EnumerateArray()
            .Single(c => c.GetProperty("fieldPath").GetString() == "name")
            .GetProperty("newValue").GetString();

        Assert.Equal("NameFromModB", name);
    }

    // #281: Copy as New Record is the same contract — an explicit templateSourceOrigin names which
    // copy of the filename supplies the template fields, and must not be displaced by the origin
    // the filename alone would resolve to (ModA, the load-order copy).
    [Fact]
    public async Task CopyAsNewFromTheShadowedColumn_CopiesThatColumnsContent()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var create = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString("Target.esp")}/records",
            new
            {
                templateFormKey = "000800:Shared.esp",
                templateSourcePlugin = "Shared.esp",
                templateSourceOrigin = "ModB",
                source = "user",
            });
        create.EnsureSuccessStatusCode();

        var formKey = (await create.Content.ReadFromJsonAsync<JsonElement>())
            .GetProperty("formKey").GetString();
        var staged = await _client.GetFromJsonAsync<JsonElement>(
            $"/changes?formKey={Uri.EscapeDataString(formKey!)}");
        var name = staged.EnumerateArray()
            .Single(c => c.GetProperty("fieldPath").GetString() == "name")
            .GetProperty("newValue").GetString();

        Assert.Equal("NameFromModB", name);
    }

    [Fact]
    public async Task UnloadingTheShadowedCopy_LeavesNoRowNoColumnAndNoRecords()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var unload = await _client.PostAsJsonAsync("/plugins/unload", new { plugin = "Shared.esp", origin = "ModB" });
        unload.EnsureSuccessStatusCode();

        // ADR-0035: hidden means *absent*, not collapsed — to the user these files simply are not
        // loaded. Unloading is how that is implemented, so nothing may survive it: not the session
        // entry, not the compare column, not a single indexed record.
        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        Assert.DoesNotContain(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModB");

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        Assert.DoesNotContain(compare.GetProperty("overrides").EnumerateArray(),
            o => o.GetProperty("origin").GetString() == "ModB");

        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        Assert.DoesNotContain(records.GetProperty("items").EnumerateArray(),
            r => r.GetProperty("origin").GetString() == "ModB");

        // The copy that shadows it is untouched — unload is not a session reload.
        Assert.Contains(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModA");
    }

    [Fact]
    public async Task LoadingTheSameCopyTwice_LeavesOneEntryAndAWorkingCompare()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);
        var shadowed = fx.Plugins.Single(p => p.Origin == "ModB");

        // The visibility toggle re-issues load for everything it discovered, so a second load of a
        // copy already open is an ordinary event, not a caller error.
        var again = await _client.PostAsJsonAsync("/plugins/load", new { path = shadowed.Path, origin = shadowed.Origin });
        again.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        Assert.Single(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModB");

        // A duplicate session entry would make every column-keyed lookup ambiguous — GetCompare
        // builds its masters/participation dictionaries by ColumnKey and would throw on the pair.
        var compare = await _client.GetAsync($"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        Assert.Equal(HttpStatusCode.OK, compare.StatusCode);
    }

    [Fact]
    public async Task UnloadingALoadOrderPlugin_IsRefused()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        // The toggle only ever unloads what it loaded. Dropping a load-order plugin's index would
        // silently change winners for every FormKey it carries, which is a session reload wearing
        // a different name.
        var unload = await _client.PostAsJsonAsync("/plugins/unload", new { plugin = "Shared.esp", origin = "ModA" });

        Assert.Equal(HttpStatusCode.Conflict, unload.StatusCode);
    }

    [Fact]
    public async Task ShadowedCopyLoadedOnDemand_IsReadOnlyAndOutsideTheLoadOrder()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var shadowed = plugins.EnumerateArray().Single(p => p.GetProperty("origin").GetString() == "ModB");

        // ADR-0036: read-only, because an edit to a file the game does not load produces no
        // observable change anywhere. ADR-0035: non-participating, so it can never take a winner
        // from the copy that shadows it.
        Assert.True(shadowed.GetProperty("isImmutable").GetBoolean());
        Assert.False(shadowed.GetProperty("participates").GetBoolean());
        Assert.False(shadowed.GetProperty("inLoadOrder").GetBoolean());
        // It shares the shadowing copy's slot so the two render adjacent in the compare grid.
        Assert.Equal(
            plugins.EnumerateArray().Single(p => p.GetProperty("origin").GetString() == "ModA").GetProperty("loadOrderIndex").GetInt32(),
            shadowed.GetProperty("loadOrderIndex").GetInt32());
    }
}
