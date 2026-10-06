using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTableNameTests
{
    [Fact]
    public async Task ARecordReadLazilyFromAPlugin_BelongsToItsGrupsTable_ThoughItsTableIsBoundToASiblingClass()
    {
        using var scratch = new ScratchDirectory("medit-recordtablename-");
        var mod = new Fallout4Mod(ModKey.FromFileName("Settings.esp"), Fallout4Release.Fallout4);
        mod.GameSettings.Add(new GameSettingInt(mod, "iSetting"));
        mod.GameSettings.Add(new GameSettingFloat(mod, "fSetting"));
        mod.GameSettings.Add(new GameSettingString(mod, "sSetting"));
        var path = Path.Combine(scratch.Path, mod.ModKey.FileName);
        await mod.BeginWrite.ToPath(path).WithNoLoadOrder().WriteAsync();
        using var read = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(mod.ModKey, path), Fallout4Release.Fallout4);
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

        Assert.All(read.GameSettings, setting => Assert.Equal("gmst", RecordTableName.Of(setting, schemas)));
    }

    [Fact]
    public void ARecordClassThatInheritsItsGrupSignature_BelongsToThatGrupsTable()
    {
        const string deletedObjectModificationMutagenReadsWhenADeletedOmodHasNoData =
            "Mutagen.Bethesda.Fallout4.DeletedObjectModification";
        var inheriting = typeof(AObjectModification).Assembly.GetType(deletedObjectModificationMutagenReadsWhenADeletedOmodHasNoData);
        Assert.NotNull(inheriting);

        Assert.Equal("omod", RecordTableName.Of(inheriting, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)));
    }
}
