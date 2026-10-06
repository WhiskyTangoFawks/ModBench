using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public sealed class PluginExtensionsQueryServiceTests
{
    [Fact]
    public void GetCreatable_AReleaseWithLightPlugins_NamesEveryExtension()
    {
        var extensions = new PluginExtensionsQueryService(FakeLoadOrder.Of(GameRelease.Fallout4)).GetCreatable();

        Assert.Equal([".esm", ".esl", ".esp"], extensions);
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    [InlineData(GameRelease.OblivionRE)]
    public void GetCreatable_AReleaseWithoutLightPlugins_LeavesOutEsl(GameRelease release)
    {
        var extensions = new PluginExtensionsQueryService(FakeLoadOrder.Of(release)).GetCreatable();

        Assert.Equal([".esm", ".esp"], extensions);
    }

    [Fact]
    public void GetCreatable_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var service = new PluginExtensionsQueryService(new LoadOrderHolder());

        Assert.Throws<NoLoadOrderException>(() => service.GetCreatable());
    }
}
