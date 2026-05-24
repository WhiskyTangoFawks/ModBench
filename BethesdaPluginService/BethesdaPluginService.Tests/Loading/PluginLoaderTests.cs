using BethesdaPluginService.Core.Loading;

namespace BethesdaPluginService.Tests.Loading;

public class PluginLoaderTests(TestPluginFixture fixture) : IClassFixture<TestPluginFixture>
{
    [Fact]
    public void LoadPlugins_ReturnsCorrectMetadata()
    {
        var loader = new PluginLoader();
        var plugins = loader.LoadPlugins(fixture.DataFolder, fixture.PluginsTxtPath);

        Assert.Single(plugins);
        var plugin = plugins[0];
        Assert.Equal(TestPluginFixture.PluginName, plugin.Name);
        Assert.Equal(0, plugin.LoadOrderIndex);
        Assert.False(plugin.IsMaster);
        Assert.False(plugin.IsLight);
        Assert.Empty(plugin.Masters);
        Assert.Equal(TestPluginFixture.RecordCount, plugin.RecordCount);
    }
}
