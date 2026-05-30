using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests;

public sealed class TestPluginFixture : IDisposable
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;
    public const string PluginName = "TestPlugin.esp";
    public const int RecordCount = 2;
    public FormKey Npc1FormKey { get; }

    private readonly PluginFixtureData _data;

    public TestPluginFixture()
    {
        FormKey npc1 = default;
        _data = new PluginFixtureBuilder()
            .WithPlugin(PluginName, mod =>
            {
                npc1 = mod.Npcs.AddNew("TestNPC01").FormKey;
                mod.Npcs.AddNew("TestNPC02");
            })
            .Build();
        Npc1FormKey = npc1;
    }

    public void Dispose() => _data.Dispose();
}
