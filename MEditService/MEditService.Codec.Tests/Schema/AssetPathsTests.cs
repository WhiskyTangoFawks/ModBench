using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Tes5 = Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Schema;

public class AssetPathsTests
{
    private static Tes5.SkyrimMod NewMod() => new(ModKey.FromFileName("Assets.esp"), Tes5.SkyrimRelease.SkyrimSE);

    private static List<AssetPath> Collected(Tes5.Static record) =>
        AssetPaths.Collect(
            Document.Parse(RecordTextCodec.SerializeToText(record, GameRelease.SkyrimSE)),
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE)["stat"].RecordColumns);

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
    public void ARecordThatNamesNoFile_HasNoPath()
    {
        var record = NewMod().Statics.AddNew("Holder");

        Assert.Empty(Collected(record));
    }
}
