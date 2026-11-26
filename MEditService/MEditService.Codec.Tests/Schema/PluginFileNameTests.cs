using MEditService.Codec.Schema;

namespace MEditService.Codec.Tests.Schema;

public sealed class PluginFileNameTests
{
    [Theory]
    [InlineData("Mod.esp", PluginFileNameFault.None)]
    [InlineData("sub/Mod.esp", PluginFileNameFault.InvalidCharacter)]
    [InlineData("Mo\td.esp", PluginFileNameFault.InvalidCharacter)]
    [InlineData(".esp", PluginFileNameFault.NoName)]
    [InlineData("  .esp", PluginFileNameFault.NoName)]
    [InlineData("Null", PluginFileNameFault.NoPluginExtension)]
    [InlineData("Mod.txt", PluginFileNameFault.NoPluginExtension)]
    [InlineData("Mod", PluginFileNameFault.NoPluginExtension)]
    public void AName_IsAPluginFileName_OrSaysWhyNot_NeverThrowing(string name, PluginFileNameFault expected)
    {
        Assert.Equal(expected, PluginFileName.FaultOf(name, out _));
    }
}
