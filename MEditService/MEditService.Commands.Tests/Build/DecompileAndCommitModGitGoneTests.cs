using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Build;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class DecompileAndCommitModGitGoneTests
{
    [Fact]
    public async Task InitMod_WhenGitCannotRun_RefusesTheWholeSelection_WithoutNamingAnyMod()
    {
        using var dataFolder = new ScratchDirectory("medit-init-nogit-data-");
        var loadOrder = new LoadOrderSnapshot(dataFolder, null, GameRelease.Fallout4, [], [], [], [], [], [], Language.English);

        var result = await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "AnyMod", source: new GitGoneSourceAdapter());

        Assert.Equal(DecompileAndCommitRefusal.GitUnavailable, result.WholeSelectionRefusal().Refusal);
    }
}
