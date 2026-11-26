using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorAtomicValueTests
{
    [Theory]
    [InlineData("kywd", "Color", true)]
    [InlineData("cell", "Lighting.AmbientColor", true)]
    [InlineData("wthr", "LightningColor", false)]
    [InlineData("lens", "Sprites.[].Data.Tint", false)]
    public void AColorHoldsAlpha_AsMutagensBinaryTranslationKeepsIt(string table, string path, bool holdsAlpha)
    {
        var color = SchemaFields.At(GameRelease.Fallout4, table, path);

        Assert.Equal("color", color.Type);
        Assert.Null(color.Fields);
        Assert.Equal(holdsAlpha, color.HoldsAlpha);
    }
}
