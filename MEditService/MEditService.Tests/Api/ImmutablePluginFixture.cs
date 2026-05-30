using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// Creates a data folder containing Fallout4.esm (implicit / immutable) and a user plugin.
/// Plugins.txt lists only the user plugin so Fallout4.esm is loaded as an implicit listing.
/// </summary>
public sealed class ImmutablePluginFixture : IDisposable
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;
    public const string ImmutablePluginName = "Fallout4.esm";
    public const string UserPluginName = "UserMod.esp";
    public FormKey UserNpcFormKey { get; }

    private readonly PluginFixtureData _data;

    public ImmutablePluginFixture()
    {
        FormKey userNpc = default;
        _data = new PluginFixtureBuilder("medit-imm")
            .WithPlugin(ImmutablePluginName, listed: false)
            .WithPlugin(UserPluginName, mod => userNpc = mod.Npcs.AddNew("ImmTestNPC").FormKey)
            .Build();
        UserNpcFormKey = userNpc;
    }

    public void Dispose() => _data.Dispose();
}
