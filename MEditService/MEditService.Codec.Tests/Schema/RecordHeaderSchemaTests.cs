using System.Globalization;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class RecordHeaderSchemaTests
{
    private static RecordTableSchema Schema(string table) =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table];

    private static ColumnSpec[] HeaderOf(string table) =>
        [.. Schema(table).RecordColumns.Where(c => c.Field.IsRecordHeaderMember)];

    private static ColumnSpec RecordFlags(string table) =>
        HeaderOf(table).Single(c => c.Name == "MajorRecordFlagsRaw");

    private static long Bit(EnumMember member) =>
        long.Parse(member.BitValue ?? throw new InvalidOperationException($"{member.Value} has no bit."), CultureInfo.InvariantCulture);

    [Fact]
    public void TheHeaderMembers_AreXEditsRows_InItsOrder_UnderItsLabels()
    {
        var header = HeaderOf("weap");

        Assert.Equal(
            ["MajorRecordFlagsRaw", "FormKey", "VersionControl", "FormVersion", "Version2"],
            header.Select(c => c.Name));
        Assert.Equal(
            ["Record Flags", "FormID", "Version Control Info 1", "Form Version", "Version Control Info 2"],
            header.Select(c => c.Field.DisplayLabel));
    }

    [Fact]
    public void ATableOfSeveralRecordClasses_HasTheHeaderMembersOnce()
    {
        Assert.Equal(
            ["MajorRecordFlagsRaw", "FormKey", "VersionControl", "FormVersion", "Version2"],
            HeaderOf("gmst").Select(c => c.Name));
    }

    [Fact]
    public void RecordFlags_IsTheRawInteger_NamingTheGamesFlagsAndTheTypesBits_InBitOrder()
    {
        var flags = RecordFlags("cell");

        Assert.Equal("int", flags.ApiType);
        var members = flags.Field.EnumMembers;
        Assert.Contains(new EnumMember("Deleted", "32"), members);
        Assert.Contains(new EnumMember("Persistent", "1024"), members);
        Assert.Contains(new EnumMember("Compressed", "262144"), members);
        Assert.Equal(members.Select(Bit).Order(), members.Select(Bit));
    }

    [Fact]
    public void ABitTheGameAndTheTypeBothName_TakesTheTypesNarrowerName_Once()
    {
        var bit17 = RecordFlags("cell").Field.EnumMembers.Where(m => m.BitValue == "131072").ToList();

        Assert.Equal([new EnumMember("OffLimits", "131072")], bit17);
    }

    [Fact]
    public void ATypesFlagViewWhoseMembersAreNoSingleBits_NamesNoBitOfRecordFlags()
    {
        var names = RecordFlags("misc").Field.EnumMembers.Select(m => m.Value).ToList();

        Assert.DoesNotContain("CalcFromComponents", names);
        Assert.DoesNotContain("PackInUseOnly", names);
        Assert.Contains("Deleted", names);
    }

    [Fact]
    public void TheDocumentsOtherSpellingsOfTheFlags_AreNoColumns_AndAreTheFlagsAliases()
    {
        var aliases = RecordFlags("cell").Aliases;

        Assert.Equal(["Fallout4MajorRecordFlags", "IsCompressed", "IsDeleted", "MajorFlags"], aliases.Order(StringComparer.Ordinal));
        Assert.Empty(Schema("cell").RecordColumns.Select(c => c.Name).Intersect(aliases));
    }

    [Fact]
    public void TheFormID_IsTheFormKey_AsText()
    {
        var formId = HeaderOf("npc_").Single(c => c.Name == "FormKey");

        Assert.Equal("string", formId.ApiType);
        Assert.Equal("FormKey", formId.PropertyName);
    }

    [Fact]
    public void VersionControlInfo1_IsAColumnWideEnoughForAllThirtyTwoBits()
    {
        Assert.Equal("BIGINT", HeaderOf("weap").Single(c => c.Name == "VersionControl").DuckDbType);
    }

    [Fact]
    public void APluginHeader_PresentsItsRecordHeader_ThenItsAuthorAndMasters()
    {
        Assert.Equal(
            ["ModHeader.Flags", "ModHeader.FormID", "ModHeader.Version", "ModHeader.FormVersion", "ModHeader.Version2",
                "ModHeader.Author", "ModHeader.MasterReferences"],
            Schema("header").RecordColumns.Where(c => c.Synthetic == null).Select(c => c.PropertyName));
    }

    [Fact]
    public void APluginHeadersHeaderMembers_AreItsModHeaders_UnderTheSameLabels_WithItsFormIdReadOnly()
    {
        var header = HeaderOf("header");

        Assert.Equal(
            ["ModHeader.Flags", "ModHeader.FormID", "ModHeader.Version", "ModHeader.FormVersion", "ModHeader.Version2"],
            header.Select(c => c.PropertyName));
        Assert.Equal(
            ["Record Flags", "FormID", "Version Control Info 1", "Form Version", "Version Control Info 2"],
            header.Select(c => c.Field.DisplayLabel));
        Assert.NotNull(header.Single(c => c.Name == "FormID").ReadOnlyReason);
        Assert.Contains(new EnumMember("Master", "1", "ESM"), header.Single(c => c.Name == "Flags").Field.EnumMembers);
    }
}
