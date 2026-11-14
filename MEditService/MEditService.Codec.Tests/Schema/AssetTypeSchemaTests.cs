using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class AssetTypeSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "txst", "Diffuse", "Textures", new[] { ".dds" })]
    [InlineData(GameRelease.Fallout4, "txst", "Material", "Materials", new[] { ".bgsm", ".bgem" })]
    [InlineData(GameRelease.SkyrimSE, "stat", "Model.File", "Meshes", new[] { ".nif", ".bto", ".btr" })]
    [InlineData(GameRelease.SkyrimSE, "sndr", "SoundFiles.[]", "Sound", new[] { ".wav", ".xwm", ".fuz" })]
    [InlineData(GameRelease.Starfield, "stat", "Model.File", "Meshes", new[] { ".nif" })]
    public void APathField_NamesItsAssetTypesFolderAndExtensions(GameRelease game, string table, string path, string folder, string[] extensions)
    {
        var assetType = SchemaFields.At(game, table, path).AssetType;

        Assert.NotNull(assetType);
        Assert.Equal(folder, assetType.Folder);
        Assert.Equal(extensions, assetType.Extensions);
    }

    [Fact]
    public void AFieldThatHoldsNoPath_NamesNoAssetType()
    {
        Assert.Null(SchemaFields.At(GameRelease.SkyrimSE, "stat", "EditorID").AssetType);
    }
}
