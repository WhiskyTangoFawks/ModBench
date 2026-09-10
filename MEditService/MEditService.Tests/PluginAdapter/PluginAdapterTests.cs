using MEditService.Core.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.PluginAdapter;

// ADR-0032 rule 2: the four verbs a plugin's bytes reach a live Mutagen mod through, and go back to
// bytes through. Every one takes the release, so nothing here names a game to do its work.
public sealed class PluginAdapterTests
{
    private const string PluginName = "Adapter.esp";

    private static readonly IPluginAdapter Adapter = MutagenPluginAdapter.Instance;

    private static PluginFixtureData TwoNpcPlugin(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(PluginName, mod =>
            {
                mod.Npcs.AddNew("AdapterNpc01");
                mod.Npcs.AddNew("AdapterNpc02");
            })
            .Build();

    private static ModPath PathOf(PluginFixtureData data) =>
        new(ModKey.FromFileName(PluginName), Path.Combine(data.DataFolder, PluginName));

    [Fact]
    public void OpenForRead_ReadsTheRecordsTheFileCarries_UnderTheModKeyItsNameGives()
    {
        using var data = TwoNpcPlugin("adapter-read");

        using var loaded = Adapter.OpenForRead(PathOf(data), GameRelease.Fallout4);

        Assert.Equal(ModKey.FromFileName(PluginName), loaded.Getter.ModKey);
        Assert.Equal(GameRelease.Fallout4, loaded.Getter.GameRelease);
        Assert.Equal(
            ["AdapterNpc01", "AdapterNpc02"],
            loaded.Getter.EnumerateMajorRecords().Select(r => r.EditorID).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task OpenForWrite_YieldsAModTheCallerMayChange_AndTheWriteVerbKeepsTheChange()
    {
        using var data = TwoNpcPlugin("adapter-write");
        var written = Path.Combine(data.DataFolder, "Written", PluginName);
        Directory.CreateDirectory(Path.GetDirectoryName(written)!);

        var mod = (IFallout4Mod)Adapter.OpenForWrite(PathOf(data), GameRelease.Fallout4);
        mod.Npcs.AddNew("AdapterNpc03");
        await Adapter.WriteAsync(mod, written);

        using var reread = Adapter.OpenForRead(new ModPath(ModKey.FromFileName(PluginName), written), GameRelease.Fallout4);
        Assert.Equal(
            ["AdapterNpc01", "AdapterNpc02", "AdapterNpc03"],
            reread.Getter.EnumerateMajorRecords().Select(r => r.EditorID).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void CreateEmpty_CarriesTheReleaseAndKeyItWasGiven_AndNoRecords()
    {
        var mod = Adapter.CreateEmpty(ModKey.FromFileName(PluginName), GameRelease.Fallout4);

        Assert.Equal(ModKey.FromFileName(PluginName), mod.ModKey);
        Assert.Equal(GameRelease.Fallout4, mod.GameRelease);
        Assert.Empty(mod.EnumerateMajorRecords());
    }

    [Fact]
    public async Task CreateEmpty_ThenWritten_IsAPluginTheReadVerbOpens()
    {
        var scratch = Directory.CreateTempSubdirectory("medit-adapter-create-").FullName;
        try
        {
            var path = Path.Combine(scratch, PluginName);
            var mod = Adapter.CreateEmpty(ModKey.FromFileName(PluginName), GameRelease.Fallout4);

            await Adapter.WriteAsync(mod, path);

            using var reread = Adapter.OpenForRead(new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4);
            Assert.Equal(ModKey.FromFileName(PluginName), reread.Getter.ModKey);
            Assert.Empty(reread.Getter.EnumerateMajorRecords());
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }

    // ADR-0038: the caller's order is the written order, not Mutagen's undefined default.
    [Fact]
    public async Task WriteAsync_WithAMasterOrder_WritesTheMasterListInThatOrder()
    {
        using var data = new PluginFixtureBuilder("adapter-masters")
            .WithPlugin("AlphaBase.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("BetaBase.esm", mod => mod.Npcs.AddNew("BetaNpc"))
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                foreach (var npc in built.SelectMany(b => b.Npcs))
                    mod.Npcs.GetOrAddAsOverride(npc);
            })
            .Build();
        var patch = new ModPath(ModKey.FromFileName("Patch.esp"), Path.Combine(data.DataFolder, "Patch.esp"));
        var written = Path.Combine(data.DataFolder, "Reordered", "Patch.esp");
        Directory.CreateDirectory(Path.GetDirectoryName(written)!);

        var mod = Adapter.OpenForWrite(patch, GameRelease.Fallout4);
        var reversed = mod.MasterReferences.Select(m => m.Master.FileName.ToString()).Reverse().ToList();
        Assert.Equal(["BetaBase.esm", "AlphaBase.esm"], reversed);

        await Adapter.WriteAsync(mod, written, reversed);

        using var reread = Adapter.OpenForRead(new ModPath(patch.ModKey, written), GameRelease.Fallout4);
        Assert.Equal(reversed, reread.Getter.MasterReferences.Select(m => m.Master.FileName.ToString()));
    }
}
