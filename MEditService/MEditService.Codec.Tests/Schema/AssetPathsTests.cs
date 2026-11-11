using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Fo4 = Mutagen.Bethesda.Fallout4;
using Tes5 = Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Schema;

public class AssetPathsTests
{
    private static Tes5.SkyrimMod NewMod() => new(ModKey.FromFileName("Assets.esp"), Tes5.SkyrimRelease.SkyrimSE);

    private static List<AssetPath> Collected(Tes5.Static record) =>
        AssetPaths.Collect(
            RecordTextCodec.SerializeToText(record, GameRelease.SkyrimSE),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["stat"].RecordColumns, GameRelease.SkyrimSE, "stat");

    [Fact]
    public void APathARecordNames_IsTheFileInTheDataFolder_UnderItsAssetTypesFolder()
    {
        var record = NewMod().Statics.AddNew("Holder");
        record.Model = new Tes5.Model { File = @"Architecture\Wall.nif" };

        Assert.Equal([new AssetPath(Path.Combine("Meshes", "Architecture", "Wall.nif"), "Model.File")], Collected(record));
    }

    [Fact]
    public void APathThatAlreadyStartsWithItsAssetTypesFolder_KeepsIt()
    {
        var record = NewMod().Statics.AddNew("Holder");
        record.Model = new Tes5.Model { File = @"meshes\Architecture\Wall.nif" };

        Assert.Equal([Path.Combine("meshes", "Architecture", "Wall.nif")], Collected(record).Select(path => path.DataPath));
    }

    [Fact]
    public void AFallout4Path_IsTheFileInTheDataFolder_UnderItsAssetTypesFolder()
    {
        var record = new Fo4.Fallout4Mod(ModKey.FromFileName("Assets.esp"), Fo4.Fallout4Release.Fallout4).TextureSets.AddNew("Holder");
        record.Diffuse = @"Decals\Stain_d.dds";
        record.Material = @"Decals\Stain.bgsm";

        var collected = AssetPaths.Collect(
            RecordTextCodec.SerializeToText(record, GameRelease.Fallout4),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["txst"].RecordColumns, GameRelease.Fallout4, "txst");

        Assert.Equal(
            [
                new AssetPath(Path.Combine("Textures", "Decals", "Stain_d.dds"), "Diffuse"),
                new AssetPath(Path.Combine("Materials", "Decals", "Stain.bgsm"), "Material"),
            ],
            collected);
    }

    [Fact]
    public void ARecordThatNamesNoFile_HasNoPath()
    {
        var record = NewMod().Statics.AddNew("Holder");

        Assert.Empty(Collected(record));
    }
}
