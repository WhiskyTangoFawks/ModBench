using MEditService.LoadOrder;

namespace MEditService.Tests.Plugins;

public sealed class PluginNameTests
{
    [Fact]
    public void Comparer_TreatsTwoSpellingsOfOneName_AsEqual()
    {
        PluginName lower = "shared.esp";
        PluginName mixed = "Shared.esp";

        Assert.True(PluginName.Comparer.Equals(lower, mixed));
        Assert.Equal(PluginName.Comparer.GetHashCode(lower), PluginName.Comparer.GetHashCode(mixed));
    }
}
