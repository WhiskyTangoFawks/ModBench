using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Source;

public sealed class RegisteredPluginSpellingTests : TestInstance
{
    private const string Origin = "SpellingMod";
    private readonly PluginAddress _plugin;

    public RegisteredPluginSpellingTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Mixed.ESP"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("SpellingNpc");
        _plugin = Add(mod, Origin, compiledPlugin: false);
    }

    [Fact]
    public async Task Init_OfAPluginWithAMixedCaseExtension_CommitsItsSourceRootAsRegistered()
    {
        var result = (await DecompileAndCommitEveryPluginOf.ModAsync(LoadOrder, Origin)).Value();

        Assert.Empty(result.Refused);
        var repository = TestAdapters.Source().Open(TestMod.Of(_plugin, ModFolderOf(_plugin)), GameRelease.Fallout4).Require();
        Assert.NotEmpty(repository.FormKeysUsed(_plugin).Value());
        Assert.Empty(repository.ChangedSinceLastCommit(_plugin).Value());
    }

    [Fact]
    public async Task Compile_OfAPluginWithAMixedCaseExtension_ReadsTheSourceRootAsRegistered()
    {
        Assert.Empty((await DecompileAndCommitEveryPluginOf.ModAsync(LoadOrder, Origin)).RefusalMessages());

        await CompileHandler.CompileLandedAsync(_plugin);
    }
}
