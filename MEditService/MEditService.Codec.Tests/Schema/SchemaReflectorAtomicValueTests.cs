using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class SchemaReflectorAtomicValueTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    private ColumnSpec Column(string table, string column) =>
        _reflector.GetSchemas(GameRelease.Fallout4)[table].RecordColumns.Single(c => c.Name == column);

    [Theory]
    [InlineData("kywd", "Color", true)]
    [InlineData("ligh", "Color", true)]
    [InlineData("cell", "Lighting.AmbientColor", true)]
    [InlineData("wthr", "LightningColor", false)]
    [InlineData("mato", "SinglePassColor", false)]
    [InlineData("refr", "Primitive.Color", false)]
    [InlineData("lens", "Sprites.[].Data.Tint", false)]
    public void AColorHoldsAlpha_AsMutagensBinaryTranslationKeepsIt(string table, string path, bool holdsAlpha)
    {
        var color = SchemaFields.At(GameRelease.Fallout4, table, path);

        Assert.Equal("color", color.Type);
        Assert.Null(color.Fields);
        Assert.Equal(holdsAlpha, color.HoldsAlpha);
    }

    [Fact]
    public void NoLeafButAColorHoldsAlpha()
    {
        Assert.False(Column("kywd", "EditorID").Field.HoldsAlpha);
    }
}
