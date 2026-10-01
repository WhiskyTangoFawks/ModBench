using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>ADR-0009 invariant 1: every read of a record sees only the active plugins. Patch.esp
/// overrides Base.esp's NPC with a differing level and adds an NPC of Base's race.</summary>
[Collection(WebHostCollection.Name)]
public sealed class InactivePluginReadsApiTests : HostedTests
{
    private const string Patch = "Patch.esp";

    private readonly ScatteredFixtureData _instance;
    private readonly string _npc;
    private readonly string _race;

    public InactivePluginReadsApiTests()
    {
        FormKey npc = default, race = default;
        _instance = new PluginFixtureBuilder("api-inactive-reads")
            .WithPlugin("Base.esp", mod =>
            {
                race = mod.Races.AddNew("BaseRace").FormKey;
                npc = mod.Npcs.AddNew("BaseNpc").FormKey;
            }, origin: "BaseMod")
            .WithPlugin(Patch, (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = built[0].ModKey });
                mod.Npcs.GetOrAddAsOverride(built[0].Npcs.First()).CalcMinLevel = 5;
                mod.Npcs.AddNew("PatchNpc").Race.SetTo(built[0].Races.First().FormKey);
            }, origin: "PatchMod")
            .BuildScattered();
        (_npc, _race) = (npc.ToString(), race.ToString());
    }

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task<(JsonElement Compare, JsonElement References, JsonElement Picked)> Read() => (
        await Client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(_npc)}/compare"),
        await Client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(_race)}/references"),
        await Client.GetFromJsonAsync<JsonElement>("/records?search=PatchNpc"));

    [Fact]
    public async Task APluginThatIsNotActive_IsNoColumn_NoConflict_NoReferrer_AndNoPick()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();
        var (compare, references, picked) = await Read();
        Assert.Equal(2, compare.GetProperty("overrides").GetArrayLength());
        Assert.NotEqual("OnlyOne", compare.GetProperty("conflictAll").GetString());
        Assert.Contains(references.EnumerateArray(), r => r.GetProperty("plugin").GetString() == Patch);
        Assert.NotEmpty(picked.GetProperty("items").EnumerateArray());

        var disabled = _instance.Plugins.Select(p => p.Name == Patch ? p with { Enabled = false } : p);
        (await Client.PutLoadOrder(_instance, disabled)).EnsureSuccessStatusCode();
        (compare, references, picked) = await Read();

        // editor.md, Columns, story 2; editor-conflicts.md, What takes part, story 1
        Assert.Equal("Base.esp", Assert.Single(compare.GetProperty("overrides").EnumerateArray()).GetProperty("plugin").GetString());
        Assert.Equal("OnlyOne", compare.GetProperty("conflictAll").GetString());
        // editor-referenced-by.md, The tree, story 3
        Assert.Empty(references.EnumerateArray());
        // editor-fields.md, References, story 2: the record picker
        Assert.Empty(picked.GetProperty("items").EnumerateArray());
    }
}
