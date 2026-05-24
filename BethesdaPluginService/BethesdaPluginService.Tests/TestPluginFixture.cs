using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace BethesdaPluginService.Tests;

public sealed class TestPluginFixture : IDisposable
{
    public string DataFolder { get; }
    public string PluginsTxtPath { get; }
    public const string PluginName = "TestPlugin.esp";
    public const int RecordCount = 2;

    public TestPluginFixture()
    {
        DataFolder = Path.Combine(Path.GetTempPath(), $"medit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(DataFolder);

        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("TestNPC01");
        mod.Npcs.AddNew("TestNPC02");
        mod.WriteToBinary(Path.Combine(DataFolder, PluginName));

        PluginsTxtPath = Path.Combine(DataFolder, "Plugins.txt");
        File.WriteAllText(PluginsTxtPath, $"# mEdit test\n*{PluginName}\n");
    }

    public void Dispose() => Directory.Delete(DataFolder, recursive: true);
}
