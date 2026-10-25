using System.Reflection;
using MEditService.Codec.Schema;
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

    [Theory]
    [InlineData("npc_", "Npcs")]
    [InlineData("cell", "Cells")]
    [InlineData("refr", null)]
    public void ARecordTypesGroup_IsTheModsTopLevelGroupHoldingIt_AsMutagenNamesIt_NoneForATypeHeldOnlyInsideAnother(string recordType, string? group)
    {
        Assert.Equal(group, RecordTypes.For(GameRelease.Fallout4).GroupOf(recordType));
    }

    [Theory]
    [InlineData("Npcs", "npc_")]
    [InlineData("Globals", null)]
    public void AGroupOfOneRecordClass_HoldsThatRecordType_AndOneOfSeveralHoldsNoOne_ThoughTheyShareATable(string group, string? recordType)
    {
        Assert.Equal(recordType, RecordTypes.For(GameRelease.Fallout4).OnlyRecordTypeIn(group));
    }

    [Theory]
    [InlineData("npc_", true)]
    [InlineData("cell", true)]
    [InlineData("wrld", true)]
    [InlineData("qust", true)]
    [InlineData(PluginHeader.RecordType, false)]
    [InlineData("refr", false)]
    [InlineData("navm", false)]
    [InlineData("dial", false)]
    [InlineData("info", false)]
    [InlineData("not-a-real-type", false)]
    public void ARecordType_IsCreatable_ExactlyWhenItHasATopLevelGroupOfItsOwn(string recordType, bool creatable)
    {
        var types = RecordTypes.For(GameRelease.Fallout4);

        Assert.Equal(creatable, types.IsCreatable(recordType));
        Assert.Equal(creatable, types.Creatable.Contains(recordType));
    }

    public class RecordOfNoGameClass : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => throw new NotSupportedException();
    }
}
