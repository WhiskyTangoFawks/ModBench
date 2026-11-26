using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class PlacedRotationSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "refr", "Rotation")]
    [InlineData(GameRelease.SkyrimSE, "refr", "Placement.Rotation")]
    [InlineData(GameRelease.Starfield, "refr", "Rotation")]
    public void APlacedReferencesRotation_IsMarked(GameRelease game, string table, string path)
    {
        var rotation = SchemaFields.At(game, table, path);

        Assert.Equal("vector", rotation.Type);
        Assert.True(rotation.IsPlacedRotation);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4, "refr", "Position")]
    [InlineData(GameRelease.Fallout4, "refr", "TeleportDestination.Rotation")]
    [InlineData(GameRelease.Starfield, "trns", "Rotation")]
    public void NoOtherVector_IsMarked(GameRelease game, string table, string path)
    {
        Assert.False(SchemaFields.At(game, table, path).IsPlacedRotation);
    }
}
