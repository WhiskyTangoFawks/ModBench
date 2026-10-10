using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class CreatablePluginExtensionsTests
{
    [Fact]
    public void AReleaseWithLightPlugins_NamesEveryExtension()
    {
        Assert.Equal([".esm", ".esl", ".esp"], CreatablePluginExtensions.Of(GameRelease.Fallout4));
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    [InlineData(GameRelease.OblivionRE)]
    public void AReleaseWithoutLightPlugins_LeavesOutEsl(GameRelease release)
    {
        Assert.Equal([".esm", ".esp"], CreatablePluginExtensions.Of(release));
    }
}
