using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class AssetFolderSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "txst", "Diffuse", "Textures", new[] { ".dds" })]
    [InlineData(GameRelease.Fallout4, "txst", "Material", "Materials", new[] { ".bgsm", ".bgem" })]
    [InlineData(GameRelease.SkyrimSE, "stat", "Model.File", "Meshes", new[] { ".nif", ".bto", ".btr" })]
    [InlineData(GameRelease.SkyrimSE, "sndr", "SoundFiles.[]", "Sound", new[] { ".wav", ".xwm", ".fuz" })]
    [InlineData(GameRelease.Starfield, "stat", "Model.File", "Meshes", new[] { ".nif" })]
    public void APathField_NamesItsAssetTypesFolderAndExtensions(GameRelease game, string table, string path, string folder, string[] extensions)
    {
        var field = SchemaFields.At(game, table, path);

        Assert.Equal(folder, field.AssetFolder);
        Assert.Equal(extensions, field.AssetExtensions);
    }

    [Fact]
    public void AFieldThatHoldsNoPath_NamesNoFolderAndNoExtensions()
    {
        var field = SchemaFields.At(GameRelease.SkyrimSE, "stat", "EditorID");

        Assert.Null(field.AssetFolder);
        Assert.Null(field.AssetExtensions);
    }
}
