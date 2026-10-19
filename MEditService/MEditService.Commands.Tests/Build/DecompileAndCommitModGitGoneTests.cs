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
        using var gameDir = new ScratchDirectory("medit-init-nogit-game-");
        var loadOrder = new LoadOrderSnapshot(gameDir, null, GameRelease.Fallout4, [], [], [], [], [], [], Language.English);

        var result = await DecompileAndCommitEveryPluginOf.ModAsync(loadOrder, "AnyMod", source: new GitGoneSourceAdapter());

        Assert.Equal(DecompileAndCommitRefusal.GitUnavailable, result.WholeSelectionRefusal().Refusal);
    }
}
