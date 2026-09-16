using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>switch-profile: the profile line is written and forgotten, and what reaches mEdit is
/// the next whole snapshot, so a profile with another plugin set replaces the held one rather than
/// merging into it.</summary>
[Collection(WebHostCollection.Name)]
public sealed class SwitchProfileTraceTests : IDisposable
{
    private const string Shared = "Shared.esp";
    private const string OnlyInDefault = "DefaultOnly.esp";
    private const string OnlyInModding = "ModdingOnly.esp";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;
    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-switch-profile")
        .WithPlugin(Shared, mod => mod.Npcs.AddNew("SharedNpc"), origin: "SharedMod")
        .WithPlugin(OnlyInDefault, mod => mod.Npcs.AddNew("DefaultNpc"), origin: "DefaultMod")
        .WithPlugin(OnlyInModding, mod => mod.Npcs.AddNew("ModdingNpc"), origin: "ModdingMod")
        .BuildScattered();

    public SwitchProfileTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
        _instance.Dispose();
    }

    [Fact]
    public async Task SwitchingProfile_ReplacesTheHeldLoadOrder_WithTheNewProfilesOwn()
    {
        (await _client.PutLoadOrder(_instance, "SharedMod", "DefaultMod")).EnsureSuccessStatusCode();
        var beforeSwitch = await _client.Sequence();

        (await _client.PutLoadOrder(_instance, "SharedMod", "ModdingMod")).EnsureSuccessStatusCode();

        var names = (await _client.Plugins()).Select(p => p.GetProperty("name").GetString()).ToList();
        Assert.Contains(Shared, names);
        Assert.Contains(OnlyInModding, names);
        Assert.DoesNotContain(OnlyInDefault, names);
        Assert.True(await _client.Sequence() > beforeSwitch, "switching profile left the projection where it stood");
    }

    // The new profile's plugins are read the same way as any other change: no rebuild, no restart,
    // the records of a plugin this profile is the first to list answer straight away.
    [Fact]
    public async Task ThePluginsTheNewProfileBrings_AnswerOnTheNextQuery()
    {
        (await _client.PutLoadOrder(_instance, "SharedMod")).EnsureSuccessStatusCode();

        (await _client.PutLoadOrder(_instance, "SharedMod", "ModdingMod")).EnsureSuccessStatusCode();

        var record = await _client.Record(await _client.FirstFormKey(OnlyInModding));
        Assert.Equal("ModdingNpc", record.GetProperty("editorId").GetString());
    }
}
