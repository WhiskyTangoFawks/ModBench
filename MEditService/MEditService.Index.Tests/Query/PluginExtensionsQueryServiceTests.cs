using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

public sealed class PluginExtensionsQueryServiceTests
{
    private static PluginExtensionsQueryService Holding(GameRelease release)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot("GameDir", null, release, []));
        return new PluginExtensionsQueryService(holder);
    }

    [Fact]
    public void GetCreatable_AReleaseWithLightPlugins_NamesEveryExtension()
    {
        Assert.Equal([".esm", ".esl", ".esp"], Holding(GameRelease.Fallout4).GetCreatable().Value());
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    [InlineData(GameRelease.OblivionRE)]
    public void GetCreatable_AReleaseWithoutLightPlugins_LeavesOutEsl(GameRelease release)
    {
        Assert.Equal([".esm", ".esp"], Holding(release).GetCreatable().Value());
    }

    [Fact]
    public void GetCreatable_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var service = new PluginExtensionsQueryService(new LoadOrderHolder());

        Assert.Equal(IndexRefusal.NoLoadOrder, service.GetCreatable().Refused().Refusal);
    }
}
