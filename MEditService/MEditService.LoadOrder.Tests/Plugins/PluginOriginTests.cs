namespace MEditService.LoadOrder.Tests.Plugins;

public class PluginOriginTests
{
    [Fact]
    public void TheDataDirectorysOrigin_IsTheSpellingModbenchSends()
    {
        Assert.Equal("Data/", PluginOrigin.DataDirectory);
    }
}
