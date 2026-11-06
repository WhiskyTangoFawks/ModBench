using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class PluginFlagsTests
{
    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public void AnEsl_IsAMaster_OnlyInAGameWithLightPlugins(bool gameHasLightPlugins, bool expected)
    {
        var mod = new ModFlags(ModKey.FromFileName("Plain.esl")) { CanBeSmallMaster = gameHasLightPlugins };

        Assert.Equal(expected, PluginFlags.IsMaster(mod, "Plain.esl"));
    }
}
