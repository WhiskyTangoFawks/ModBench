using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.Codec.Tests.Serialization;

public sealed class PluginDiagnosisTests
{
    [Fact]
    public void FromParseException_WalksNestedAggregateExceptionsForTheInnermostRecordException_BuiltFromARealDefectsCapturedMessagesRatherThanCommittingEveryFixtureItNeedsAShapeFrom()
    {
        var formKey = FormKey.Factory("431EDC:SouthOfTheSea.esm");
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName("SouthOfTheSea.esm");

        var innermost = new SubrecordException(
            new RecordType("XWPN"), formKey, typeof(PlacedObject), modKey, "00sots_Necropolis_WorkshopRef",
            "Expected header was not read in: XWPN");
        var aggregate1 = new AggregateException("One or more errors occurred. (Expected header was not read in: XWPN)", innermost);
        var aggregate2 = new AggregateException("One or more errors occurred. (One or more errors occurred. (Expected header was not read in: XWPN))", aggregate1);
        var outer = new RecordException(formKey: null, recordType: null, modKey: modKey, edid: null, innerException: aggregate2);

        var diagnosis = PluginDiagnosis.FromParseException(outer);

        Assert.NotNull(diagnosis.Anchor);
        Assert.Contains("PlacedObject", diagnosis.Anchor);
        Assert.Contains("431EDC:SouthOfTheSea.esm", diagnosis.Anchor);
        Assert.Contains("00sots_Necropolis_WorkshopRef", diagnosis.Anchor);
        Assert.Equal("Expected header was not read in: XWPN", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
        Assert.Null(diagnosis.Tail);
    }

    [Fact]
    public void FromParseException_WalksEveryBranchOfAMultiExceptionAggregateNotJustTheFirst()
    {
        var formKey = FormKey.Factory("431EDC:SouthOfTheSea.esm");
        var modKey = Mutagen.Bethesda.Plugins.ModKey.FromFileName("SouthOfTheSea.esm");
        var unrelatedFirstBranch = new InvalidOperationException("unrelated failure in a different parallel iteration");
        var identityBearingSecondBranch = new SubrecordException(
            new RecordType("XWPN"), formKey, typeof(PlacedObject), modKey, "SecondBranchRef",
            "Expected header was not read in: XWPN");
        var aggregate = new AggregateException("One or more errors occurred.", unrelatedFirstBranch, identityBearingSecondBranch);
        var outer = new RecordException(formKey: null, recordType: null, modKey: modKey, edid: null, innerException: aggregate);

        var diagnosis = PluginDiagnosis.FromParseException(outer);

        Assert.NotNull(diagnosis.Anchor);
        Assert.Contains("PlacedObject", diagnosis.Anchor);
        Assert.Contains("431EDC:SouthOfTheSea.esm", diagnosis.Anchor);
        Assert.Contains("SecondBranchRef", diagnosis.Anchor);
    }

    [Fact]
    public void FromParseException_WhenNoRecordExceptionIsAnywhereInTheChain_AnchorsOnNothing()
    {
        var diagnosis = PluginDiagnosis.FromParseException(new InvalidOperationException("boom"));

        Assert.Null(diagnosis.Anchor);
        Assert.Equal("boom", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
    }

    [Fact]
    public void FromParseException_RecognizesTheRealFnamMessageAsKindA()
    {
        var ex = new RecordException(
            formKey: null, recordType: null, modKey: Mutagen.Bethesda.Plugins.ModKey.FromFileName("Invented Patch.esp"),
            edid: null, message: "All FNAM strings should be the same");

        var diagnosis = PluginDiagnosis.FromParseException(ex);

        Assert.Equal("blocked upstream: Mutagen #687", diagnosis.Tail);
    }

    [Fact]
    public void FromSourceReadException_AnchorsOnTheFilePathRelativeToTheTree()
    {
        var treeRoot = Path.GetFullPath("medit-diagnosis-unit-tree");
        var filePath = Path.Combine(treeRoot, "Npcs", "FixtureNpc - 000802_Fixture.esp.json");
        var ex = FilePathedException.Enrich(new ArgumentException("Malformed FormKey string: NOT-A-FORMKEY"), filePath);

        var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);

        Assert.Equal(Path.Combine("Npcs", "FixtureNpc - 000802_Fixture.esp.json"), diagnosis.Anchor);
        Assert.Equal("Malformed FormKey string: NOT-A-FORMKEY", diagnosis.Message);
        Assert.Equal(PluginDiagnosis.UnknownClass, diagnosis.DefectClass);
    }

    [Fact]
    public void FromSourceReadException_NamesAPathItsMessageCarries_RelativeToTheTree()
    {
        var treeRoot = Path.GetFullPath("medit-diagnosis-unit-tree");
        var ex = new InvalidOperationException($"Could not locate a GameRelease to use from path: {Path.Combine(treeRoot, "RecordData.json")}");

        var diagnosis = PluginDiagnosis.FromSourceReadException(ex, treeRoot);

        Assert.Equal("Could not locate a GameRelease to use from path: RecordData.json", diagnosis.Message);
    }

    [Fact]
    public void Describe_WithNoAnchorAndNoTail_NamesThePluginAndTheUnknownClass()
    {
        var diagnosis = new PluginDiagnosis(Anchor: null, DefectClass: PluginDiagnosis.UnknownClass, Tail: null, Message: "boom");

        Assert.Equal("the plugin — unknown: boom", diagnosis.Describe());
    }

    [Fact]
    public void Describe_AClassedDiagnosisWithATail_CarriesBoth_NeitherShadowingTheOtherInTheRefusalText()
    {
        var diagnosis = new PluginDiagnosis(
            Anchor: "REGN 00ABCDEF (InventedRegion)", DefectClass: "fixed-size-subrecord-short",
            Tail: "repairable (lossless)", Message: "RDAT is 6 bytes; a REGN RDAT is always 8");

        Assert.Equal(
            "REGN 00ABCDEF (InventedRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
            diagnosis.Describe());
    }
}
