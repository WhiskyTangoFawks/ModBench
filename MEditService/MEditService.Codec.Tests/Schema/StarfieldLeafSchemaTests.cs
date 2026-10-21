using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class StarfieldLeafSchemaTests
{
    [Theory]
    [InlineData("pndt", "OrbitedData.GravityWell", "float")]
    [InlineData("sech", "Markers.[].ECTE", "string")]
    public void ALeafTheCodecSpellsAsAScalar_IsThatScalarsType(string table, string path, string type) =>
        Assert.Equal(type, SchemaFields.At(GameRelease.Starfield, table, path).Type);
}
