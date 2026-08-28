using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>#364: a two-plugin session with one contested record (an uncontested field override —
/// ConflictAll.Override, not .Conflict; a genuine two-sided disagreement needs a third plugin,
/// already covered at the service layer) and one uncontested (single-plugin) record —
/// <c>ConflictsApiTests</c>' fixture for <c>GET /records/conflicts</c>.</summary>
public sealed class ConflictPluginFixture : IApiPluginFixture<ConflictPluginFixture>
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;
    public const string BasePluginName = "ConflictBase.esp";
    public const string OverridePluginName = "ConflictOverride.esp";

    /// <summary>Overridden by the second plugin with a differing Aggression value — Override, the
    /// simplest real (non-OnlyOne/NoConflict) ConflictAll state.</summary>
    public FormKey ConflictingNpcFormKey { get; }

    /// <summary>Native to the base plugin only — never contested.</summary>
    public FormKey SolePluginNpcFormKey { get; }

    private readonly PluginFixtureData _data;

    public ConflictPluginFixture()
    {
        FormKey conflicting = default;
        FormKey solePlugin = default;

        _data = new PluginFixtureBuilder("medit-conflicts-api")
            .WithPlugin(BasePluginName, mod =>
            {
                conflicting = mod.Npcs.AddNew("ContestedNpc").FormKey;
                solePlugin = mod.Npcs.AddNew("UncontestedNpc").FormKey;
            })
            .WithPlugin(OverridePluginName, (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First(n => n.FormKey == conflicting)).Aggression =
                    Npc.AggressionType.Frenzied)
            .Build();

        ConflictingNpcFormKey = conflicting;
        SolePluginNpcFormKey = solePlugin;
    }

    public void Dispose() => _data.Dispose();

    public static ConflictPluginFixture Create() => new();
}
