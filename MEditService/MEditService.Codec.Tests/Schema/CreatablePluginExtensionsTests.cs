using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class CreatablePluginExtensionsTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    public void AReleaseWithLightPlugins_NamesEveryExtension(GameRelease release)
    {
        Assert.Equal([".esm", ".esl", ".esp"], CreatablePluginExtensions.Of(release));
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    public void AReleaseWithoutLightPlugins_LeavesOutEsl(GameRelease release)
    {
        Assert.Equal([".esm", ".esp"], CreatablePluginExtensions.Of(release));
    }
}
