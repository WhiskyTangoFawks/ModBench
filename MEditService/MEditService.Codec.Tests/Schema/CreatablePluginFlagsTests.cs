using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Schema;

public sealed class CreatablePluginFlagsTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, ModType.Plugin, "|Master|Small|Master+Small")]
    [InlineData(GameRelease.Fallout4, ModType.Master, "Master|Master+Small")]
    [InlineData(GameRelease.Fallout4, ModType.Light, "Master+Small")]
    [InlineData(GameRelease.Fallout4VR, ModType.Plugin, "|Master")]
    [InlineData(GameRelease.Fallout4VR, ModType.Master, "Master")]
    [InlineData(GameRelease.SkyrimSE, ModType.Plugin, "|Master|Small|Master+Small")]
    [InlineData(GameRelease.EnderalSE, ModType.Master, "Master|Master+Small")]
    [InlineData(GameRelease.SkyrimLE, ModType.Plugin, "|Master")]
    [InlineData(GameRelease.EnderalLE, ModType.Master, "Master")]
    [InlineData(GameRelease.SkyrimVR, ModType.Plugin, "|Master")]
    [InlineData(GameRelease.Starfield, ModType.Plugin, "")]
    [InlineData(GameRelease.Starfield, ModType.Master, "Master|Master+Small|Master+Medium")]
    [InlineData(GameRelease.Starfield, ModType.Light, "Master+Small")]
    public void ANewFile_IsOfferedTheCombinationsXEditOffersItsExtensionInTheRelease(GameRelease release, ModType type, string expected)
    {
        var offered = CreatablePluginFlags.Of(release, type).Select(combination => string.Join('+', combination));

        Assert.Equal(expected, string.Join('|', offered));
    }

    [Theory]
    [InlineData("Small", true)]
    [InlineData("small", false)]
    [InlineData("1", false)]
    [InlineData("Bogus", false)]
    public void AFlag_IsKnownByItsNameOnly(string name, bool known)
    {
        Assert.Equal(known, CreatablePluginFlags.Parse([name]) is not null);
    }
}
