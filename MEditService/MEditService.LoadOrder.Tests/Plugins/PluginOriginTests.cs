namespace MEditService.LoadOrder.Tests.Plugins;

public class PluginOriginTests
{
    [Theory]
    [InlineData(PluginOrigin.DataDirectory, "Data/")]
    [InlineData(PluginOrigin.Overwrite, "overwrite/")]
    public void ReservedOrigin_IsTheSpellingModbenchSends_AndEndsInTheCharacterNoFolderNameHolds(string origin, string sent)
    {
        Assert.Equal(sent, origin);
        Assert.EndsWith("/", origin, StringComparison.Ordinal);
    }
}
