using System.Reflection;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTypesTests
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

        Assert.All(read.GameSettings, setting => Assert.Equal("gmst", RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(setting)));
    }

    [Fact]
    public void ARecordClassThatInheritsItsGrupSignature_BelongsToThatGrupsTable()
    {
        const string deletedObjectModificationMutagenReadsWhenADeletedOmodHasNoData = "DeletedObjectModification";
        Assert.NotNull(typeof(AObjectModification).Assembly.GetType(
            $"{typeof(AObjectModification).Namespace}.{deletedObjectModificationMutagenReadsWhenADeletedOmodHasNoData}"));

        Assert.Equal("omod", RecordTypes.For(GameRelease.Fallout4).RecordTypeNamed(deletedObjectModificationMutagenReadsWhenADeletedOmodHasNoData));
    }

    [Fact]
    public void AClassNoGrupRegisters_NamesNoRecordType()
    {
        Assert.Null(RecordTypes.For(GameRelease.Fallout4).RecordTypeNamed(nameof(Fallout4MajorRecord)));
    }

    [Fact]
    public void ALiveRecordOfAClassNoGrupRegisters_IsRefused_NamingItsClass()
    {
        var record = DispatchProxy.Create<IMajorRecordGetter, RecordOfNoGameClass>();

        var refused = Assert.Throws<InvalidOperationException>(() => RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(record));

        Assert.Contains(record.GetType().Name, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ANameNoTypeOfTheGameAnswersTo_HoldsNoChildSlots()
    {
        Assert.Empty(RecordTypes.For(GameRelease.Fallout4).ChildSlotsOf("NoSuchRecordType"));
    }

    [Fact]
    public void TheCellAndTheWorldspace_AreTheirTables()
    {
        Assert.Equal("cell", RecordTypes.For(GameRelease.Fallout4).Cell);
        Assert.Equal("wrld", RecordTypes.For(GameRelease.Fallout4).Worldspace);
    }

    [Fact]
    public void ARecordsGroup_IsTheModsGroupHoldingIt_AsMutagenNamesIt()
    {
        Assert.Equal("Npcs", RecordTypes.For(GameRelease.Fallout4).GroupOf("npc_"));
    }

    [Fact]
    public void ACellsGroup_IsTheCellsGroup_ThoughItHoldsBlocksOfCells()
    {
        Assert.Equal("Cells", RecordTypes.For(GameRelease.Fallout4).GroupOf("cell"));
    }

    [Fact]
    public void ARecordHeldOnlyInsideAnother_HasNoGroup()
    {
        Assert.Null(RecordTypes.For(GameRelease.Fallout4).GroupOf("refr"));
    }

    [Fact]
    public void AGroupOfOneRecordClass_HoldsThatRecordType()
    {
        Assert.Equal("npc_", RecordTypes.For(GameRelease.Fallout4).OnlyRecordTypeIn("Npcs"));
    }

    [Fact]
    public void AGroupOfSeveralRecordClasses_HoldsNoOneRecordType_ThoughTheyShareATable()
    {
        Assert.Null(RecordTypes.For(GameRelease.Fallout4).OnlyRecordTypeIn("Globals"));
    }

    public class RecordOfNoGameClass : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => throw new NotSupportedException();
    }
}
