using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class AssetLinkSchemaTests
{
    private static ColumnSpec Column(string table, string column) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)[table].RecordColumns.Single(c => c.Name == column);

    [Fact]
    public void AnAssetLink_IsAStringLeaf_AsTheCodecSpellsItsPath()
    {
        var diffuse = Column("txst", "Diffuse");

        Assert.Equal("string", diffuse.ApiType);
        Assert.Null(diffuse.Field.Fields);
    }

    [Fact]
    public void AListOfAssetLinks_IsAnArrayOfStringLeaves()
    {
        var soundFiles = Column("sndr", "SoundFiles").Field;

        Assert.True(soundFiles.IsArray);
        Assert.Equal("string", soundFiles.ElementType?.Type);
    }
}
