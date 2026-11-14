using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public class AssetFolderSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "txst", "Diffuse", "Textures")]
    [InlineData(GameRelease.Fallout4, "txst", "Material", "Materials")]
    [InlineData(GameRelease.SkyrimSE, "stat", "Model.File", "Meshes")]
    [InlineData(GameRelease.SkyrimSE, "sndr", "SoundFiles.[]", "Sound")]
    [InlineData(GameRelease.Starfield, "stat", "Model.File", "Meshes")]
    public void APathField_NamesTheFolderItsAssetTypeKeepsItsFilesIn(GameRelease game, string table, string path, string folder)
    {
        Assert.Equal(folder, SchemaFields.At(game, table, path).AssetFolder);
    }

    [Fact]
    public void AFieldThatHoldsNoPath_NamesNoFolder()
    {
        Assert.Null(SchemaFields.At(GameRelease.SkyrimSE, "stat", "EditorID").AssetFolder);
    }
}
