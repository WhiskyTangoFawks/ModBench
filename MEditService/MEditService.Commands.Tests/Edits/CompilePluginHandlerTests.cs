using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginHandlerTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task ASelectionNamingAPluginTwice_CompilesItOnce()
    {
        var spelledAgain = new PluginAddress(_mod.Plugin.Name.ToUpperInvariant(), _mod.Plugin.Origin);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin, spelledAgain]);

        Assert.Empty(result.Refused);
        Assert.Equal([_mod.Plugin], result.Landed.Select(landed => landed.Item));
    }

    // Patch.esp overrides Master.esp's NPC and links a keyword of each master, and Master.esp is disabled.
    private static Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileAPatchOfADisabledMaster(
        LoadOrderOfPlugins plugins, bool patchEnabled)
    {
        var game = Plugin("Fallout4.esm", mod => mod.Keywords.AddNew("GameKeyword"));
        var master = Plugin("Master.esp", mod =>
        {
            mod.Npcs.AddNew("MasterNpc");
            mod.Keywords.AddNew("MasterKeyword");
        });
        var patch = Plugin("Patch.esp", mod =>
        {
            mod.ModHeader.MasterReferences.Add(new MasterReference { Master = master.ModKey });
            mod.Npcs.Add(new Npc(master.Npcs.First().FormKey, Fallout4Release.Fallout4)
            {
                EditorID = "MasterNpc",
                Keywords =
                [
                    new FormLink<IKeywordGetter>(game.Keywords.First().FormKey),
                    new FormLink<IKeywordGetter>(master.Keywords.First().FormKey),
                ],
            });
        });
        plugins.Load((game, false), (master, false), (patch, true));
        plugins.Relist(Address(master), entry => entry with { Enabled = false });
        plugins.Relist(Address(patch), entry => entry with { Enabled = patchEnabled });
        return plugins.CompileHandler.CompileAsync([Address(patch)]);
    }

    [Fact]
    public async Task ADisabledPlugin_WhoseMasterIsDisabledToo_Compiles()
    {
        using var plugins = new LoadOrderOfPlugins();

        var result = await CompileAPatchOfADisabledMaster(plugins, patchEnabled: false);

        Assert.Empty(result.Refused);
        Assert.Single(result.Landed);
    }

    [Fact]
    public async Task ADisabledPlugin_LinkingIntoItsDisabledMaster_ReportsNoDanglingLink()
    {
        using var plugins = new LoadOrderOfPlugins();

        var result = await CompileAPatchOfADisabledMaster(plugins, patchEnabled: false);

        Assert.DoesNotContain(Assert.Single(result.Landed).Outcome, diagnostic => diagnostic.Message.StartsWith("Keywords", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnActivePlugin_LinkingIntoADisabledPlugin_ReportsTheLinkDangling_AsTheGameLoadsNoTargetForIt()
    {
        using var plugins = new LoadOrderOfPlugins();

        var result = await CompileAPatchOfADisabledMaster(plugins, patchEnabled: true);

        Assert.Contains(Assert.Single(result.Landed).Outcome, diagnostic => diagnostic.Message.StartsWith("Keywords: [1]", StringComparison.Ordinal));
    }

    [Fact]
    public async Task APluginTheLoadOrderDoesNotHold_IsRefusedByType_AndTheOthersCompile()
    {
        var stranger = new PluginAddress("Stranger.esp", CompileFixture.Origin);

        var result = await _mod.CompileHandler.CompileAsync([stranger, _mod.Plugin]);

        Assert.Equal([_mod.Plugin], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal((stranger, CompileRefusal.PluginNotInLoadOrder), (refused.Item, refused.Refusal));
        Assert.Equal("Stranger.esp is not in the load order.", refused.Message);
    }

    [Fact]
    public async Task APluginWhoseSourceIsUnreadable_IsRefusedBeforeAnyWrite_NamingDecompile()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        Directory.Delete(PluginSourceRoot.In(_mod.ModFolder, CompileFixture.PluginName), recursive: true);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(CompileRefusal.PluginSourceUnreadable, refused.Refusal);
        Assert.Equal(
            $"{CompileFixture.PluginName}'s plugin source is unreadable, so it cannot be compiled. " +
            "Decompile the plugin to regenerate the source.",
            refused.Message);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }

    [Fact]
    public async Task ASourceFolderThatHoldsNoFiles_IsRefusedBeforeAnyWrite_AsHoldingNoFiles()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        var root = PluginSourceRoot.In(_mod.ModFolder, CompileFixture.PluginName);
        Directory.Delete(root, recursive: true);
        Directory.CreateDirectory(root);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        Assert.Equal(CompileRefusal.NoSource, Assert.Single(result.Refused).Refusal);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
